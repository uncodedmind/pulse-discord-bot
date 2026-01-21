// Pulse Analytics - Discord Bot Collector
// Este bot coleta dados do Discord e envia para o Supabase via Edge Function

const { Client, GatewayIntentBits, Events } = require('discord.js');
const crypto = require('crypto');

// ============ CONFIGURAÇÃO ============
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL; // https://rreaslwetphwcylvccir.supabase.co
const DISCORD_INGEST_SECRET = process.env.DISCORD_INGEST_SECRET;

// Validar variáveis de ambiente
if (!DISCORD_TOKEN || !SUPABASE_URL || !DISCORD_INGEST_SECRET) {
  console.error('❌ Variáveis de ambiente faltando!');
  console.error('Necessário: DISCORD_TOKEN, SUPABASE_URL, DISCORD_INGEST_SECRET');
  process.exit(1);
}

const INGEST_URL = `${SUPABASE_URL}/functions/v1/discord-ingest`;

// Inicializar Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ],
});

// ============ HELPERS ============

// Log com timestamp
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Criar assinatura HMAC
function createSignature(payload) {
  return crypto
    .createHmac('sha256', DISCORD_INGEST_SECRET)
    .update(payload)
    .digest('hex');
}

// Enviar evento para a Edge Function
async function sendEvent(event) {
  const body = JSON.stringify(event);
  const signature = createSignature(body);

  try {
    const response = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Erro ao enviar evento ${event.event_type}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`❌ Erro de rede ao enviar evento:`, error.message);
    return false;
  }
}

// ============ EVENT HANDLERS ============

// Bot ficou online
client.once(Events.ClientReady, (c) => {
  log(`✅ Bot online como ${c.user.tag}`);
  log(`📡 Network Analysis habilitado: mentions e replies serão rastreados`);
  log(`🔗 Enviando dados para: ${INGEST_URL}`);
  log(`📊 Conectado a ${c.guilds.cache.size} servidor(es)`);

  c.guilds.cache.forEach(guild => {
    log(`   - ${guild.name} (${guild.memberCount} membros)`);
  });
});

// ============ MENSAGENS ============
client.on(Events.MessageCreate, async (message) => {
  // Ignorar bots e DMs
  if (message.author.bot || !message.guild) return;

  const serverId = message.guild.id;
  const channelId = message.channel.id;
  const channelName = message.channel.name;
  const authorId = message.author.id;
  const authorUsername = message.author.username;
  const authorAvatar = message.author.displayAvatarURL({ format: 'png', size: 128 });

  // Coletar menções (IDs dos usuários mencionados)
  const mentions = message.mentions.users
    .filter(user => !user.bot)
    .map(user => user.id);

  // Coletar reply (ID do usuário sendo respondido)
  let replyToUserId = null;
  if (message.reference?.messageId) {
    try {
      const repliedMessage = await message.fetchReference();
      if (repliedMessage?.author && !repliedMessage.author.bot) {
        replyToUserId = repliedMessage.author.id;
      }
    } catch (e) {
      // Mensagem original pode ter sido deletada
    }
  }

  // Enviar evento
  const success = await sendEvent({
    event_type: 'message_created',
    server_id: serverId,
    ts: message.createdAt.toISOString(),
    data: {
      channel_id: channelId,
      channel_name: channelName,
      author_id: authorId,
      author_username: authorUsername,
      author_avatar: authorAvatar,
      mentions: mentions,
      reply_to_user_id: replyToUserId,
    },
  });

  if (success) {
    // Log menções
    for (const mentionedId of mentions) {
      const mentionedUser = message.mentions.users.get(mentionedId);
      log(`   🔗 ${authorUsername} mencionou ${mentionedUser?.username || mentionedId}`);
    }
    // Log reply
    if (replyToUserId) {
      const repliedUser = message.mentions.repliedUser;
      log(`   ↩️ ${authorUsername} respondeu ${repliedUser?.username || replyToUserId}`);
    }
  }

  log(`💬 [${message.guild.name}/#${channelName}] ${authorUsername}: ${message.content.substring(0, 50)}...`);
});

// ============ MEMBER JOIN ============
client.on(Events.GuildMemberAdd, async (member) => {
  const success = await sendEvent({
    event_type: 'member_join',
    server_id: member.guild.id,
    ts: new Date().toISOString(),
    data: {
      discord_id: member.user.id,
      username: member.user.username,
      avatar: member.user.displayAvatarURL({ format: 'png', size: 128 }),
    },
  });

  if (success) {
    log(`➕ [${member.guild.name}] ${member.user.username} entrou no servidor`);
  }
});

// ============ MEMBER LEAVE ============
client.on(Events.GuildMemberRemove, async (member) => {
  const success = await sendEvent({
    event_type: 'member_leave',
    server_id: member.guild.id,
    ts: new Date().toISOString(),
    data: {
      discord_id: member.user.id,
    },
  });

  if (success) {
    log(`➖ [${member.guild.name}] ${member.user.username} saiu do servidor`);
  }
});

// ============ VOICE STATE ============
const voiceSessions = new Map();

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const serverId = newState.guild?.id || oldState.guild?.id;
  const memberId = member.user.id;
  const sessionKey = `${serverId}-${memberId}`;

  // Entrou em canal de voz
  if (!oldState.channel && newState.channel) {
    voiceSessions.set(sessionKey, {
      startedAt: new Date(),
      channelId: newState.channel.id,
      channelName: newState.channel.name,
    });
    log(`🎤 [${newState.guild.name}] ${member.user.username} entrou em ${newState.channel.name}`);
  }

  // Saiu do canal de voz
  else if (oldState.channel && !newState.channel) {
    const session = voiceSessions.get(sessionKey);
    if (session) {
      const endedAt = new Date();
      const durationMinutes = Math.round((endedAt - session.startedAt) / 60000);

      await sendEvent({
        event_type: 'voice_session',
        server_id: serverId,
        ts: session.startedAt.toISOString(),
        data: {
          channel_id: session.channelId,
          channel_name: session.channelName,
          member_id: memberId,
          duration_minutes: durationMinutes,
        },
      });

      voiceSessions.delete(sessionKey);
      log(`🔇 [${oldState.guild.name}] ${member.user.username} saiu de ${oldState.channel.name} (${durationMinutes} min)`);
    }
  }

  // Trocou de canal
  else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
    const session = voiceSessions.get(sessionKey);
    if (session) {
      const endedAt = new Date();
      const durationMinutes = Math.round((endedAt - session.startedAt) / 60000);

      await sendEvent({
        event_type: 'voice_session',
        server_id: serverId,
        ts: session.startedAt.toISOString(),
        data: {
          channel_id: session.channelId,
          channel_name: session.channelName,
          member_id: memberId,
          duration_minutes: durationMinutes,
        },
      });
    }

    voiceSessions.set(sessionKey, {
      startedAt: new Date(),
      channelId: newState.channel.id,
      channelName: newState.channel.name,
    });
    log(`🔀 [${newState.guild.name}] ${member.user.username} trocou para ${newState.channel.name}`);
  }
});

// ============ ERROR HANDLING ============
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// ============ INICIAR BOT ============
log('🚀 Iniciando Pulse Analytics Bot...');
log('📡 Network Analysis habilitado: mentions e replies serão rastreados');
client.login(DISCORD_TOKEN);
