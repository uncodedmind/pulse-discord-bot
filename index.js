// Pulse Analytics - Discord Bot Collector
// Este bot coleta dados do Discord e envia para o Supabase

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ============ CONFIGURAÇÃO ============
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Validar variáveis de ambiente
if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Variáveis de ambiente faltando!');
  console.error('Necessário: DISCORD_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// Inicializar Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

// Formatar data para YYYY-MM-DD
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Log com timestamp
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ============ NOVO: Salvar interação entre membros ============
async function saveInteraction(serverId, sourceId, targetId, interactionType, channelId) {
  // Ignorar auto-interações
  if (sourceId === targetId) return;

  const today = getToday();

  try {
    // Verificar se já existe interação hoje
    const { data: existing } = await supabase
      .from('member_interactions')
      .select('id, count')
      .eq('server_id', serverId)
      .eq('source_member_id', sourceId)
      .eq('target_member_id', targetId)
      .eq('interaction_type', interactionType)
      .eq('channel_id', channelId)
      .eq('interaction_date', today)
      .single();

    if (existing) {
      // Incrementar contador
      await supabase
        .from('member_interactions')
        .update({ count: existing.count + 1 })
        .eq('id', existing.id);
    } else {
      // Criar nova interação
      await supabase
        .from('member_interactions')
        .insert({
          server_id: serverId,
          source_member_id: sourceId,
          target_member_id: targetId,
          interaction_type: interactionType,
          channel_id: channelId,
          interaction_date: today,
          count: 1
        });
    }
  } catch (error) {
    console.error(`Erro ao salvar interação ${interactionType}:`, error.message);
  }
}

// ============ EVENT HANDLERS ============

// Bot ficou online
client.once(Events.ClientReady, (c) => {
  log(`✅ Bot online como ${c.user.tag}`);
  log(`📊 Conectado a ${c.guilds.cache.size} servidor(es)`);

  // Listar servidores
  c.guilds.cache.forEach(guild => {
    log(`   - ${guild.name} (${guild.memberCount} membros)`);
  });
});

// ============ MENSAGENS ============
client.on(Events.MessageCreate, async (message) => {
  // Ignorar bots
  if (message.author.bot) return;

  // Ignorar DMs
  if (!message.guild) return;

  const serverId = message.guild.id;
  const channelId = message.channel.id;
  const channelName = message.channel.name;
  const authorId = message.author.id;
  const authorUsername = message.author.username;
  const authorAvatar = message.author.avatar;
  const today = getToday();

  try {
    // 1. Upsert em messages_daily (incrementar contador)
    const { error: msgError } = await supabase.rpc('increment_message_count', {
      p_server_id: serverId,
      p_channel_id: channelId,
      p_channel_name: channelName,
      p_date: today
    });

    // Se a função RPC não existir, fazer manualmente
    if (msgError && msgError.message.includes('function')) {
      // Tentar upsert direto
      const { data: existing } = await supabase
        .from('messages_daily')
        .select('id, message_count')
        .eq('server_id', serverId)
        .eq('channel_id', channelId)
        .eq('date', today)
        .single();

      if (existing) {
        await supabase
          .from('messages_daily')
          .update({ message_count: existing.message_count + 1 })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('messages_daily')
          .insert({
            server_id: serverId,
            channel_id: channelId,
            channel_name: channelName,
            date: today,
            message_count: 1
          });
      }
    }

    // 2. Upsert em members
    const { data: existingMember } = await supabase
      .from('members')
      .select('id, total_messages')
      .eq('server_id', serverId)
      .eq('discord_id', authorId)
      .single();

    if (existingMember) {
      await supabase
        .from('members')
        .update({
          username: authorUsername,
          avatar: authorAvatar,
          last_active_at: new Date().toISOString(),
          total_messages: existingMember.total_messages + 1
        })
        .eq('id', existingMember.id);
    } else {
      await supabase
        .from('members')
        .insert({
          server_id: serverId,
          discord_id: authorId,
          username: authorUsername,
          avatar: authorAvatar,
          last_active_at: new Date().toISOString(),
          total_messages: 1,
          health_score: 50,
          churn_risk: 0,
          segment: 'new'
        });
    }

    // ============ NOVO: Processar mentions para Network Analysis ============
    const mentionedUsers = message.mentions.users.filter(user => !user.bot);
    for (const [mentionedId, mentionedUser] of mentionedUsers) {
      await saveInteraction(serverId, authorId, mentionedId, 'mention', channelId);
      log(`   🔗 ${authorUsername} mencionou ${mentionedUser.username}`);
    }

    // ============ NOVO: Processar reply para Network Analysis ============
    if (message.reference?.messageId) {
      const repliedUser = message.mentions.repliedUser;
      if (repliedUser && !repliedUser.bot && repliedUser.id !== authorId) {
        await saveInteraction(serverId, authorId, repliedUser.id, 'reply', channelId);
        log(`   ↩️ ${authorUsername} respondeu ${repliedUser.username}`);
      }
    }

    log(`💬 [${message.guild.name}/#${channelName}] ${authorUsername}: ${message.content.substring(0, 50)}...`);

  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
  }
});

// ============ MEMBER JOIN ============
client.on(Events.GuildMemberAdd, async (member) => {
  const serverId = member.guild.id;

  try {
    // 1. Criar/atualizar membro
    await supabase
      .from('members')
      .upsert({
        server_id: serverId,
        discord_id: member.user.id,
        username: member.user.username,
        avatar: member.user.avatar,
        joined_at: member.joinedAt?.toISOString() || new Date().toISOString(),
        last_active_at: new Date().toISOString(),
        total_messages: 0,
        health_score: 50,
        churn_risk: 30, // Novos membros têm risco moderado
        segment: 'new',
        is_active: true
      }, {
        onConflict: 'server_id,discord_id'
      });

    // 2. Registrar evento
    await supabase
      .from('member_events')
      .insert({
        server_id: serverId,
        member_discord_id: member.user.id,
        event_type: 'join',
        event_date: new Date().toISOString()
      });

    log(`➕ [${member.guild.name}] ${member.user.username} entrou no servidor`);

  } catch (error) {
    console.error('Erro ao processar member join:', error.message);
  }
});

// ============ MEMBER LEAVE ============
client.on(Events.GuildMemberRemove, async (member) => {
  const serverId = member.guild.id;

  try {
    // 1. Marcar como inativo
    await supabase
      .from('members')
      .update({ is_active: false })
      .eq('server_id', serverId)
      .eq('discord_id', member.user.id);

    // 2. Registrar evento
    await supabase
      .from('member_events')
      .insert({
        server_id: serverId,
        member_discord_id: member.user.id,
        event_type: 'leave',
        event_date: new Date().toISOString()
      });

    log(`➖ [${member.guild.name}] ${member.user.username} saiu do servidor`);

  } catch (error) {
    console.error('Erro ao processar member leave:', error.message);
  }
});

// ============ VOICE STATE ============
// Armazenar sessões ativas de voz
const voiceSessions = new Map();

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const serverId = newState.guild?.id || oldState.guild?.id;
  const memberId = member.user.id;
  const sessionKey = `${serverId}-${memberId}`;

  try {
    // Entrou em canal de voz
    if (!oldState.channel && newState.channel) {
      voiceSessions.set(sessionKey, {
        startedAt: new Date(),
        channelId: newState.channel.id,
        channelName: newState.channel.name
      });

      log(`🎤 [${newState.guild.name}] ${member.user.username} entrou em ${newState.channel.name}`);
    }

    // Saiu do canal de voz
    else if (oldState.channel && !newState.channel) {
      const session = voiceSessions.get(sessionKey);

      if (session) {
        const endedAt = new Date();
        const durationMinutes = Math.round((endedAt - session.startedAt) / 60000);

        // Salvar sessão no Supabase
        await supabase
          .from('voice_sessions')
          .insert({
            server_id: serverId,
            member_discord_id: memberId,
            channel_id: session.channelId,
            channel_name: session.channelName,
            started_at: session.startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
            duration_minutes: durationMinutes
          });

        // Atualizar total de voice do membro
        const { data: memberData } = await supabase
          .from('members')
          .select('id, total_voice_minutes')
          .eq('server_id', serverId)
          .eq('discord_id', memberId)
          .single();

        if (memberData) {
          await supabase
            .from('members')
            .update({
              total_voice_minutes: (memberData.total_voice_minutes || 0) + durationMinutes,
              last_active_at: new Date().toISOString()
            })
            .eq('id', memberData.id);
        }

        voiceSessions.delete(sessionKey);
        log(`🔇 [${oldState.guild.name}] ${member.user.username} saiu de ${oldState.channel.name} (${durationMinutes} min)`);
      }
    }

    // Trocou de canal
    else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      // Finalizar sessão antiga
      const session = voiceSessions.get(sessionKey);
      if (session) {
        const endedAt = new Date();
        const durationMinutes = Math.round((endedAt - session.startedAt) / 60000);

        await supabase
          .from('voice_sessions')
          .insert({
            server_id: serverId,
            member_discord_id: memberId,
            channel_id: session.channelId,
            channel_name: session.channelName,
            started_at: session.startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
            duration_minutes: durationMinutes
          });
      }

      // Iniciar nova sessão
      voiceSessions.set(sessionKey, {
        startedAt: new Date(),
        channelId: newState.channel.id,
        channelName: newState.channel.name
      });

      log(`🔀 [${newState.guild.name}] ${member.user.username} trocou para ${newState.channel.name}`);
    }

  } catch (error) {
    console.error('Erro ao processar voice state:', error.message);
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
