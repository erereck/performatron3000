# Performatron 3000

Rich Presence do **YouTube normal** no Discord, com atividade do tipo **Listening**, nome da música no status compacto, capa, artista, barra de progresso e botão para abrir o vídeo.

A ideia é simples: fica **desligado por padrão** e você liga só quando quiser performar que está ouvindo música.

## O que já faz

- `♪` / atividade **Listening** no Discord (`type: 2`), não “Jogando YouTube”.
- Usa o **nome da música** como texto principal do status (`status_display_type: details`).
- Mostra título, artista/canal, capa e botão **Abrir no YouTube**.
- Barra de progresso sincronizada enquanto a música toca.
- Detecta play, pause, seek, troca de vídeo e navegação SPA do YouTube.
- Em pause, para de fingir que a barra continua andando e mostra `⏸ Pausado`.
- Pode esconder a presença durante anúncios.
- Limpa automaticamente títulos como `(Official Music Video)`, `[Lyrics]`, `- Topic`, `VEVO` etc.
- Escolhe o YouTube que está realmente tocando mesmo se a aba estiver em segundo plano.
- **Capa quadrada** opcional (ligada por padrão): corta o centro da thumbnail para transformar aquelas thumbs com capa de álbum no meio + barras pretas dos lados em uma capa quadrada de verdade.
- Companion Windows bem pequeno, escrito em Go e sem Electron.

## Como a capa quadrada funciona

O Discord aceita uma URL pública como imagem de Rich Presence. Quando `Capa quadrada` está ligada, a extensão monta uma URL do `images.weserv.nl` pedindo um crop central `512x512` com `fit=cover`.

Isso é extremamente leve no PC porque o crop acontece no servidor de imagem, não localmente. Para uploads de música que têm uma capa quadrada no centro e barras pretas nas laterais, o resultado normalmente encaixa exatamente no álbum.

Se você não quiser que a thumbnail passe por um proxy de imagem externo, basta desligar `Capa quadrada`; aí o Performatron manda a thumbnail original do YouTube direto para o Discord.

## Arquitetura

```text
YouTube
  ↓
extension/content.js
  ↓
extension/background.js
  ↓ HTTP local 127.0.0.1:42421
companion.exe
  ↓ Discord RPC por Named Pipe
Discord Desktop
```

A extensão **não usa token do Discord**. Ela só precisa do Application ID público de um app que você cria no Developer Portal.

## Instalação rápida

### 1. Baixe o pacote pronto

Vá em **Actions → Build Performatron 3000 → artifact `performatron3000-windows`**.

O artifact contém:

- `performatron-companion.exe`
- `run-hidden.vbs`
- `extension.zip`
- `LEIA-ME.txt`

### 2. Crie o app no Discord

1. Abra o Discord Developer Portal.
2. Crie uma Application nova.
3. Nome recomendado: **YouTube** (assim o card expandido fica bonito).
4. Copie o **Application ID**.

Não crie bot, não cole Bot Token e não precisa de OAuth para esta função.

### 3. Instale a extensão

1. Extraia `extension.zip`.
2. Abra `chrome://extensions` ou `edge://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta extraída.

### 4. Rode o companion

- `performatron-companion.exe`: abre com uma janelinha de log.
- `run-hidden.vbs`: abre o companion escondido em segundo plano.

Deixe o **Discord Desktop** aberto.

### 5. Performar

1. Abra a extensão.
2. Cole o Application ID.
3. Abra uma música no YouTube.
4. Clique em **PERFORMAR NO DISCORD**.

O toggle usa `chrome.storage.session`, então volta para **OFF quando o navegador é reiniciado**.

## Como deve aparecer

No perfil/lista de membros, a intenção é algo equivalente a:

```text
♪ POWER
```

Ao abrir a atividade:

```text
Listening to YouTube

POWER
Kanye West
02:31 ━━━━━━━━━━━━━ 04:52

[Abrir no YouTube]
```

A renderização exata depende da versão do cliente do Discord.

## Desenvolvimento

### Extensão

Não tem build step. A pasta `extension/` já é uma extensão Manifest V3 carregável diretamente.

### Companion

Requer Go 1.22+ para compilar manualmente:

```powershell
cd companion
go build -trimpath -ldflags="-s -w" -o performatron-companion.exe .
```

O binário Windows fica em torno de poucos MB e usa o próprio protocolo RPC do Discord via `\\.\pipe\discord-ipc-N`.

## Notas técnicas

- O Discord documenta `SET_ACTIVITY` com suporte a `Listening (2)`.
- `status_display_type: 2` faz o campo `details` ser usado no texto compacto da atividade.
- Listening/Watching com `start` + `end` podem mostrar uma barra de tempo.
- Assets de Activity podem ser URLs externas públicas.
- O companion tenta `discord-ipc-0` até `discord-ipc-9`.
- O endpoint local só escuta em `127.0.0.1:42421` e rejeita Origins comuns de sites; aceita chamadas de extensões de navegador.

## Estado atual

Primeira versão funcional. O próximo passo natural é testar em Discord Stable/Canary e ajustar qualquer diferença que o cliente real faça com `name`, `status_display_type` ou assets externos.
