# Saara

Call a phone number, talk to Saara, and your Windows laptop does the work.

Saara is a voice agent on [Sarvam AI](https://www.sarvam.ai). She listens to you on a phone call, decides what to do, and calls a small server on your laptop through a secure tunnel:

```
Your phone → Sarvam phone number → Saara (Sarvam voice agent)
           → Cloudflare tunnel → laptop server (this repo) → your laptop does it
```

## What Saara can do

- Open websites and apps, search Google, play YouTube
- Find and open files from Desktop, Documents, Downloads, OneDrive and Pictures
- Take and read notes, set talking timers, run focus sessions
- Control music and volume, take screenshots, lock the laptop (asks first)
- Draft Gmail emails (you press send yourself)
- Track deadlines and phone you before they're due, or when the battery is low
- Read your Google Classroom to-do list and attach assignments

Only your own phone number is obeyed, and every request needs your secret token. Saara can only run the fixed actions in `arrc/server.js`. Nothing said on a call ever runs as a command.

## Dashboard

A live console at `http://localhost:3710` shows every action as it happens, with system telemetry, deadlines, an activity timeline and the tunnel URL to paste into Sarvam. It is only reachable on the laptop itself, never through the tunnel.

## Setup

You need Windows, [Node.js](https://nodejs.org) (LTS), a Sarvam account with credits and a phone number, and Google Chrome for Classroom.

1. **Install**
   ```
   cd arrc
   npm install
   copy .env.example .env
   ```
2. **Configure `arrc/.env`**
   - `JARVIS_TOKEN`: a long random password. Make one with
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `OWNER_NUMBER`: your mobile number, digits only with country code, e.g. `919876543210`
3. **Install the tunnel** (once): `winget install --id Cloudflare.cloudflared`
4. **Start everything**: double-click `start-saara.bat`. It opens the server, the tunnel and the dashboard. Keep both windows open.
5. **Create the agent in Sarvam** (indus.sarvam.ai → Build → Agents)
   - Instructions: paste `J-agent/1-instructions-prompt.txt`
   - Variable `opening_line`, default `Hey Boss, it's Saara. What can I do for you?`; Greeting `{{opening_line}}`
   - Add an API tool named `laptop_action`:
     | Field | Value |
     |---|---|
     | Description | paste `J-agent/2-tool-description.txt` |
     | Method / URL | `POST` `https://<your-tunnel>.trycloudflare.com/action` (the dashboard shows it) |
     | Auth | Bearer token = your `JARVIS_TOKEN`, saved as a secret |
     | Params | `action`, `input`: let the agent decide · `caller`: agent variable **User Identifier** |
6. **Commit** the agent, attach it to your number under Deploy → Phone Numbers, and call it. Once real calls work, set `ALLOW_NO_CALLER=false` in `.env`.

The free tunnel address changes every time cloudflared restarts. Update the tool URL in Sarvam and commit again when it does.

### Optional

- **Saara calls you**: fill the `SARVAM_*` and `ARRC_*` values in `.env` (workspace key, org and workspace IDs, agent ID and version, phone number and connection ID).
- **Google Classroom**: set `CLASSROOM_SUBMIT=attach`, restart, and sign in once in the Chrome window that opens. `attach` only attaches files; you still press Turn in.

## Add your own action

Every action is a function inside `const ACTIONS = {` in `arrc/server.js`. Whatever it returns is what Saara says. Add the action name to the tool description and one line to the instructions, then commit a new agent version.

## Keep it safe

Never share `arrc/.env`, your tunnel address or your Sarvam keys. They are git-ignored, along with the Classroom sign-in profile.

## Author

Harshith ([@Harshith-ka](https://github.com/Harshith-ka))

Built on the ARRC laptop-server starter kit from the Sarvam AI hackathon.
