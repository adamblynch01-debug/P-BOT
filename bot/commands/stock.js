const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Manage product stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add keys/accounts to a product')
        .addStringOption(opt =>
          opt.setName('product_id').setDescription('Product ID').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('items')
            .setDescription('Items to add, separated by commas or newlines')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check stock count for a product')
        .addStringOption(opt =>
          opt.setName('product_id').setDescription('Product ID').setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const product_id = interaction.options.getString('product_id');
      const raw = interaction.options.getString('items');
      const items = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

      try {
        const res = await axios.post(`${BACKEND}/api/stock/add`, {
          secret: process.env.API_SECRET,
          product_id,
          items,
        });

        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('✅ Stock Added')
          .addFields(
            { name: 'Product ID', value: product_id, inline: true },
            { name: 'Items Added', value: `${res.data.added}`, inline: true },
          )
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    }

    if (sub === 'check') {
      const product_id = interaction.options.getString('product_id');

      try {
        const res = await axios.get(`${BACKEND}/api/stock/${product_id}`);

        const embed = new EmbedBuilder()
          .setColor(res.data.available > 0 ? 0x00ff00 : 0xff0000)
          .setTitle('📦 Stock Status')
          .addFields(
            { name: 'Product ID', value: product_id, inline: true },
            { name: 'Available',  value: `${res.data.available}`, inline: true },
          )
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Failed: ${err.message}` });
      }
    }
  }
};
