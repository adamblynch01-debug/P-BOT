const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('order')
    .setDescription('Look up or manage an order')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('lookup')
        .setDescription('Look up an order by ID')
        .addStringOption(opt =>
          opt.setName('order_id').setDescription('Order ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('forceconfirm')
        .setDescription('Manually confirm a payment')
        .addStringOption(opt =>
          opt.setName('order_id').setDescription('Order ID').setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const order_id = interaction.options.getString('order_id');

    if (sub === 'lookup') {
      try {
        const res = await axios.get(`${BACKEND}/api/orders/${order_id}`);
        const o = res.data;

        const statusEmoji = {
          pending:   '⏳',
          paid:      '💰',
          delivered: '✅',
          expired:   '❌',
        }[o.status] || '❓';

        const embed = new EmbedBuilder()
          .setColor(o.status === 'delivered' ? 0x00ff00 : o.status === 'pending' ? 0xffff00 : 0xff0000)
          .setTitle(`${statusEmoji} Order ${order_id.slice(0, 8)}...`)
          .addFields(
            { name: 'Status',     value: o.status.toUpperCase(),       inline: true },
            { name: 'Payment',    value: o.payment_method.toUpperCase(), inline: true },
            { name: 'Total',      value: `$${o.total}`,                inline: true },
            { name: 'Delivered',  value: o.delivered ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Created',    value: new Date(o.created_at).toLocaleString(), inline: true },
            { name: 'Expires',    value: new Date(o.expires_at).toLocaleString(), inline: true },
          )
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Order not found or error: ${err.message}` });
      }
    }

    if (sub === 'forceconfirm') {
      try {
        const res = await axios.post(`${BACKEND}/api/orders/confirm`, {
          secret: process.env.API_SECRET,
          order_id,
          amount_received: 0,
          method: 'manual',
        });

        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('✅ Order Force Confirmed')
          .setDescription(`Order \`${order_id}\` has been manually confirmed and delivery triggered.`)
          .setFooter({ text: `Confirmed by ${interaction.user.tag}` })
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    }
  }
};
