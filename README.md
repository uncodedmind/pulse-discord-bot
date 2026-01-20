# Pulse Analytics - Discord Bot

Bot que coleta dados do Discord e envia para o Supabase.

## O que esse bot faz:

- ✅ Captura mensagens → salva em `messages_daily`
- ✅ Captura joins → salva em `members` + `member_events`
- ✅ Captura leaves → salva em `member_events`
- ✅ Captura voice → salva em `voice_sessions`
- ✅ Atualiza `last_active_at` dos membros
- ✅ Fica online 24/7 (bolinha verde)

## Variáveis de Ambiente (configurar no Railway):

```
DISCORD_TOKEN=seu_token_do_bot
SUPABASE_URL=https://rreaslwetphwcylvccir.supabase.co
SUPABASE_SERVICE_KEY=sua_service_key
```

## Deploy no Railway:

1. Crie um repositório no GitHub com esses arquivos
2. No Railway, conecte o repositório
3. Configure as variáveis de ambiente
4. Deploy automático!
