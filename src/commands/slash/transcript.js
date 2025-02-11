const { SlashCommand } = require('@eartharoid/dbf');
const { ApplicationCommandOptionType } = require('discord.js');
const fs = require('fs');
const { join } = require('path');
const Mustache = require('mustache');
const {
	AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const Cryptr = require('cryptr');
const { decrypt } = new Cryptr(process.env.ENCRYPTION_KEY);

module.exports = class TranscriptSlashCommand extends SlashCommand {
	constructor(client, options) {
		const name = 'transcript';
		super(client, {
			...options,
			description: client.i18n.getMessage(null, `commands.slash.${name}.description`),
			descriptionLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.description`),
			dmPermission: false,
			name,
			nameLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.name`),
			options: [
				{
					autocomplete: true,
					name: 'ticket',
					required: true,
					type: ApplicationCommandOptionType.String,
				},
				{
					name: 'member',
					required: false,
					type: ApplicationCommandOptionType.User,
				},
			].map(option => {
				option.descriptionLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.description`);
				option.description = option.descriptionLocalizations['en-GB'];
				option.nameLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.name`);
				return option;
			}),
		});

		Mustache.escape = text => text; // don't HTML-escape
		this.template = fs.readFileSync(
			join('./user/templates/', this.client.config.templates.transcript + '.mustache'),
			{ encoding: 'utf8' },
		);
	}

	async fillTemplate(ticketId) {
		/** @type {import("client")} */
		const client = this.client;
		const ticket = await client.prisma.ticket.findUnique({
			include: {
				archivedChannels: true,
				archivedMessages: {
					orderBy: { createdAt: 'asc' },
					where: { external: false },
				},
				archivedRoles: true,
				archivedUsers: true,
				category: true,
				claimedBy: true,
				closedBy: true,
				createdBy: true,
				feedback: true,
				guild: true,
				questionAnswers: true,
			},
			where: { id: ticketId },
		});
		if (!ticket) throw new Error(`Ticket ${ticketId} does not exist`);

		ticket.claimedBy = ticket.archivedUsers.find(u => u.userId === ticket.claimedById);
		ticket.closedBy = ticket.archivedUsers.find(u => u.userId === ticket.closedById);
		ticket.createdBy = ticket.archivedUsers.find(u => u.userId === ticket.createdById);

		if (ticket.closedReason) ticket.closedReason = decrypt(ticket.closedReason);
		if (ticket.feedback?.comment) ticket.feedback.comment = decrypt(ticket.feedback.comment);
		if (ticket.topic) ticket.topic = decrypt(ticket.topic).replace(/\n/g, '\n\t');

		ticket.archivedUsers.forEach((user, i) => {
			if (user.displayName) user.displayName = decrypt(user.displayName);
			user.username = decrypt(user.username);
			ticket.archivedUsers[i] = user;
		});

		ticket.archivedMessages.forEach((message, i) => {
			message.author = ticket.archivedUsers.find(u => u.userId === message.authorId);
			message.content = JSON.parse(decrypt(message.content));
			message.text = message.content.content?.replace(/\n/g, '\n\t') ?? '';
			message.content.attachments?.forEach(a => (message.text += '\n\t' + a.url));
			message.content.embeds?.forEach(() => (message.text += '\n\t[embedded content]'));
			message.number = 'M' + String(i + 1).padStart(ticket.archivedMessages.length.toString().length, '0');
			ticket.archivedMessages[i] = message;
		});

		ticket.pinnedMessageIds = ticket.pinnedMessageIds.map(id => ticket.archivedMessages.find(message => message.id === id)?.number);

		const channelName = ticket.category.channelName
			.replace(/{+\s?(user)?name\s?}+/gi, ticket.createdBy?.username)
			.replace(/{+\s?(nick|display)(name)?\s?}+/gi, ticket.createdBy?.displayName)
			.replace(/{+\s?num(ber)?\s?}+/gi, ticket.number);
		const fileName = `${channelName}.${this.client.config.templates.transcript.split('.').slice(-1)[0]}`;
		const transcript = Mustache.render(this.template, {
			channelName,
			closedAtFull: function () {
				return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
					dateStyle: 'full',
					timeStyle: 'long',
					timeZone: 'Etc/UTC',
				}).format(this.closedAt);
			},
			createdAtFull: function () {
				return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
					dateStyle: 'full',
					timeStyle: 'long',
					timeZone: 'Etc/UTC',
				}).format(this.createdAt);
			},
			createdAtTimestamp: function () {
				return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
					dateStyle: 'short',
					timeStyle: 'long',
					timeZone: 'Etc/UTC',
				}).format(this.createdAt);
			},
			guildName: client.guilds.cache.get(ticket.guildId)?.name,
			pinned: ticket.pinnedMessageIds.join(', '),
			ticket,
		});

		return {
			fileName,
			transcript,
		};
	}

	/**
	 * @param {import("discord.js").ChatInputCommandInteraction} interaction
	 */
	async run(interaction) {
		await interaction.deferReply({ ephemeral: true });

		const ticket = await this.client.prisma.ticket.findUnique({
			include: {
				archivedChannels: true,
				archivedMessages: {
					orderBy: { createdAt: 'asc' },
					where: { external: false },
				},
				archivedRoles: true,
				archivedUsers: true,
				category: true,
				claimedBy: true,
				closedBy: true,
				createdBy: true,
				feedback: true,
				guild: true,
				questionAnswers: true,
			},
			where: { id: interaction.options.getString('ticket', true) },
		});


		const {
			fileName,
			transcript,
		} = await this.fillTemplate(interaction.options.getString('ticket', true));
		const attachment = new AttachmentBuilder()
			.setFile(Buffer.from(transcript))
			.setName(fileName);

		const user = await this.client.users.fetch(ticket.createdById);

		const embed = new EmbedBuilder().setColor(ticket.guild.primaryColour).addFields([
			{
				inline: true,
				name: 'Ticket Owner',
				value: `<@${user.id}>`,
			},
			{
				inline: true,
				name: 'Transcript URL',
				value: `[Link to Transcript](${process.env.TICKETS_URL}/tickets/transcript-${ticket.id}.html)`,
			},
		]);

		const row =
						new ActionRowBuilder().addComponents(
							new ButtonBuilder()
								.setStyle(ButtonStyle.Link)
								.setLabel('Link to Ticket Transcript')
								.setURL(`${process.env.TICKETS_URL}/tickets/transcript-${ticket.id}.html`),
						);

		await interaction.editReply({
			components: [row],
			embeds: [embed],
			files: [attachment],
		});
		// TODO: add portal link
	}
};
