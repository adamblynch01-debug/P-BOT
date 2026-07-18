require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ─── Discord Client ──────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

client.commands = new Collection();

// ─── Load Commands ───────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    console.log(`[Bot] Loaded command: ${command.data.name}`);
  }
}

// ─── Events ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] Serving guild: ${process.env.DISCORD_GUILD_ID}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[Bot] Command error (${interaction.commandName}):`, err);
    const msg = { content: '❌ An error occurred.', ephemeral: true };
    interaction.replied || interaction.deferred
      ? await interaction.followUp(msg)
      : await interaction.reply(msg);
  }
});

// ─── Internal HTTP Server ────────────────────────────────
// Backend calls this to trigger Discord DMs and notifications
const app = express();
app.use(express.json());

app.post('/internal/new_order', (req, res) => {
  if (req.body.secret !== process.env.API_SECRET) return res.status(401).end();
  const { order, payment_info } = req.body;
  handleNewOrder(order, payment_info, client);
  res.json({ ok: true });
});

app.post('/internal/deliver_goods', (req, res) => {
  if (req.body.secret !== process.env.API_SECRET) return res.status(401).end();
  const { order_id, discord_id, email, goods } = req.body;
  handleDelivery(order_id, discord_id, email, goods, client);
  res.json({ ok: true });
});

const BOT_PORT = process.env.BOT_PORT || 3001;
app.listen(BOT_PORT, () => console.log(`[Bot] Internal server on port ${BOT_PORT}`));

// ─── Order Notification ──────────────────────────────────
async function handleNewOrder(order, payment_info, client) {
  try {
    const logChannelId = process.env.ORDER_LOG_CHANNEL_ID;
    if (!logChannelId) return;

    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!channel) return;

    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('🛒 New Order')
      .addFields(
        { name: 'Order ID', value: `\`${order.id}\``, inline: true },
        { name: 'Payment', value: order.payment_method.toUpperCase(), inline: true },
        { name: 'Total', value: `$${order.total}`, inline: true },
        { name: 'Email', value: order.email, inline: true },
        { name: 'Status', value: '⏳ Pending Payment', inline: true },
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Bot] New order notification error:', err.message);
  }
}

// ─── Delivery via Discord DM ─────────────────────────────
async function handleDelivery(order_id, discord_id, email, goods, client) {
  try {
    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle('✅ Your H8ED Order is Ready!')
      .setDescription('Thank you for your purchase. Here are your goods:')
      .setTimestamp();

    for (const g of goods) {
      const value = g.items.join('\n') || 'See below';
      embed.addFields({ name: `📦 ${g.product}`, value: `\`\`\`${value}\`\`\`` });
    }

    embed.setFooter({ text: `Order ID: ${order_id}` });

    // Send DM if discord_id provided
    if (discord_id) {
      const user = await client.users.fetch(discord_id).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] });
        console.log(`[Bot] Delivered goods to Discord user ${discord_id}`);
      }
    }

    // Log in order log channel
    const logChannelId = process.env.ORDER_LOG_CHANNEL_ID;
    if (logChannelId) {
      const channel = await client.channels.fetch(logChannelId).catch(() => null);
      if (channel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('📦 Order Delivered')
          .addFields(
            { name: 'Order ID', value: `\`${order_id}\``, inline: true },
            { name: 'Discord', value: discord_id ? `<@${discord_id}>` : 'N/A', inline: true },
            { name: 'Email', value: email, inline: true },
          )
          .setTimestamp();
        await channel.send({ embeds: [logEmbed] });
      }
    }
  } catch (err) {
    console.error('[Bot] Delivery error:', err.message);
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
