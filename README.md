# counterpart-rails

One Vercel server that gives the cOunTerPart agent (on AgenticOrg) its rails:

| MCP connector | URL | Tools |
|---|---|---|
| Delhivery (mock + 3 BUILD) | `/mcp/delhivery` | track_shipment, edit_shipment, ndr_action, get_ndr_status, issue_delegate_otp (BUILD), rider_bridge (BUILD), book_slot (BUILD) |
| Gnani (real) | `/mcp/gnani` | speech_to_text, text_to_speech |
| Google (real) | `/mcp/google` | search_emails, get_email, check_availability, list_events |
| WhatsApp via Twilio (real) | `/mcp/whatsapp` | send_text, send_voice, read_messages |

Delhivery REST mock (same names and fields as Delhivery's docs): `GET /api/v1/packages/json/?waybill=`, `POST /api/p/edit`, `POST /api/p/update`, `GET /api/cmu/get_bulk_upl/{UPL}`. BUILD endpoints: `POST /api/x/delegate-otp`, `GET /api/x/rider-bridge`, `POST /api/x/slot`.

Other routes: `/panel` (control panel), `/twilio/webhook` (incoming WhatsApp), `/media/<id>.<ext>` (audio), `/health`.

## Deploy
1. Push this folder to a private GitHub repo.
2. Vercel > Add New > Project > Import the repo. Framework preset: Other. No build command.
3. Add the variables from `.env.example` under Environment Variables. Deploy.
4. Vercel project > Storage > Upstash Redis (free) > Connect to project. Then Deployments > Redeploy.
5. Open `<url>/health` (should show ok) and `<url>/panel` (enter MCP_API_KEY). The header must say "Redis: on".

## WhatsApp budget
The panel starts in DRY-RUN: the agent's messages appear in "Virtual phones", nothing is sent, nothing is spent.
Testers reply from the panel (text or an audio file). Switch to LIVE only for recording. The server refuses live sends once the budget is used.

## Twilio incoming messages (needed for LIVE only)
Twilio Console > Messaging > Try it out > Send a WhatsApp message > Sandbox settings >
"When a message comes in": `<url>/twilio/webhook`, method POST > Save.

## Local test
`MCP_API_KEY=testkey node test/local-server.js` then `node test/smoke.mjs` (43 checks, no external calls needed).
