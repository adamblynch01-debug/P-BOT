const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000';

const configKeys = {
  cashapp: { key: 'CASHAPP_CASHTAG',        label: 'Cash App Cashtag',       example: '$YourTag' },
  paypal:  { key: 'PAYPAL_EMAIL',            label: 'PayPal Email',           example: 'you@paypal.com' },
  gmail:   { key: 'GMAIL_USER',              label: 'Gmail Address',          example: 'payments@gmail.com' },
  gmailpw: { key: 'GMAIL_PASSWORD',          label: 'Gmail App Password',     example: 'xxxx xxxx xxxx xxxx' },
  store:   { key: 'STORE_NAME',              label: 'Store Name',             example: 'H8ED Shop' },
  cashfee: { key: 'CASHAPP_FEE_PERCENT',     label: 'Cash App Fee %',         example: '10' },
  payfee:  { key: 'PAYPAL_FEE_PERCENT',      label: 'PayPal Fee %',           example: '10' },
  cryptodc:{ key: 'CRYPTO_DISCOUNT_PERCENT', label: 'Crypto Discount %',      example: '5' },
  btcxpub: { key: 'BTC_XPUB',               label: 'BTC xPub Key',           example: 'xpub...' },
  ltcxpub: { key: 'LTC_XPUB',               label: 'LTC xPub Key',           example: 'Ltub...' },
  logchan: { key: 'ORDER_LOG_CHANNEL_ID',    label: 'Order Log Channel ID',   example: '123456789' },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure H8ED Shop settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set a config value')
        .addStringOption(opt =>
          opt.setName('setting')
            .setDescription('Which setting to update')
            .setRequired(true)
            .addChoices(
              { name: '💵 Cash App Cashtag',      value: 'cashapp' },
              { name: '🅿️ PayPal Email',           value: 'paypal'  },
              { name: '📧 Gmail Address',          value: 'gmail'   },
              { name: '🔑 Gmail App Password',     value: 'gmailpw' },
              { name: '🏪 Store Name',             value: 'store'   },
              { name: '💸 Cash App Fee %',         value: 'cashfee' },
              { name: '💸 PayPal Fee %',           value: 'payfee'  },
              { name: '📉 Crypto Discount %',      value: 'cryptodc'},
              { name: '₿  BTC xPub Key',          value: 'btcxpub' },
              { name: 'Ł  LTC xPub Key',          value: 'ltcxpub' },
              { name: '📋 Order Log Channel ID',   value: 'logchan' },
            )
        )
        .addStringOption(opt =>
          opt.setName('value')
            .setDescription('The value to set')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View current config')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      try {
        const res = await axios.get(`${BACKEND}/api/config`);
        const cfg = res.data;

        const embed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle('⚙️ H8ED Shop Config')
          .addFields(
            { name: '🏪 Store Name',        value: cfg.store_name || 'Not set',         inline: true },
            { name: '💵 Cash App',          value: cfg.cashapp_cashtag || '❌ Not set', inline: true },
            { name: '🅿️ PayPal',            value: cfg.paypal_email || '❌ Not set',    inline: true },
            { name: '💸 Cash App Fee',      value: `${cfg.cashapp_fee}%`,               inline: true },
            { name: '💸 PayPal Fee',        value: `${cfg.paypal_fee || 10}%`,          inline: true },
            { name: '📉 Crypto Discount',   value: `${cfg.crypto_discount}%`,           inline: true },
            { name: '₿ BTC Enabled',        value: cfg.payment_methods.btc ? '✅' : '❌', inline: true },
            { name: 'Ł LTC Enabled',        value: cfg.payment_methods.ltc ? '✅' : '❌', inline: true },
          )
          .setFooter({ text: 'Use /config set to update values' })
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Failed to fetch config: ${err.message}` });
      }
    }

    if (sub === 'set') {
      const setting = interaction.options.getString('setting');
      const value = interaction.options.getString('value');
      const cfg = configKeys[setting];

      if (!cfg) return await interaction.editReply({ content: '❌ Unknown setting.' });

      try {
        await axios.post(`${BACKEND}/api/config/update`, {
          secret: process.env.API_SECRET,
          key: cfg.key,
          value,
        });

        // If setting log channel, update bot env live
        if (setting === 'logchan') {
          process.env.ORDER_LOG_CHANNEL_ID = value;
        }

        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('✅ Config Updated')
          .addFields(
            { name: 'Setting', value: cfg.label, inline: true },
            { name: 'Value',   value: setting === 'gmailpw' ? '`[hidden]`' : `\`${value}\``, inline: true },
          )
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return await interaction.editReply({ content: `❌ Failed to update: ${err.message}` });
      }
    }
  }
};
