# Dual Discord Voice Bot

This project runs **two Discord bots from one Node.js project**.

## Commands

Only the Discord user whose ID is in `OWNER_ID` can use them:

- `.join` — both bots join the voice channel you are currently in.
- `.playrec` — the Loud bot plays `sound.mp3` continuously in a loop.
- `.stopall` — stops the loop and makes both bots leave the voice channel.

## Setup

1. Install Node.js 20+ (Node.js 22 LTS is recommended).
2. Put your audio file in the project root and name it `sound.mp3`.
3. Rename `.env.example` to `.env`.
4. Fill in:
   - `CONTROL_TOKEN` = first bot token
   - `LOUD_TOKEN` = second bot token
   - `OWNER_ID` = your Discord user ID
5. Open a terminal in this folder and run:

```bash
npm install
npm start
```

## Discord bot settings

For the **Control bot**, enable the **Message Content Intent** in the Discord Developer Portal.

Both bots need permission to:
- View Channel
- Connect
- Speak

Both bot accounts must be invited to the same server.

## Important

Never share your bot tokens publicly. If a token has already been exposed, regenerate it in the Discord Developer Portal.

The loop is controlled by the bot: when the audio reaches the end, it starts the same file again. `.stopall` sets the loop off, stops playback, and disconnects both bots.
