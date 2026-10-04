# Lulu design research demo

This fork keeps Paseo's dashboard, composer, streamed timeline, Markdown renderer, and tool cards. The study layer adds student login, an isolated chat, picture uploads, research annotations, non-AI steps, automatic recording, and a read-only researcher dashboard. It does not calculate cognitive offloading or Bloom categories. Those need a separate researcher coding process.

## Run the synthetic demo

Use Node 22 and Docker. Keep the runtime directory outside the checkout: it contains generated passwords and recorded data. Build dependencies once:

```sh
npm ci
npm rebuild node-pty better-sqlite3
npm run build:server
EXPO_PUBLIC_LULU_STUDY=1 npm run build:web --workspace=@getpaseo/app
docker build -t lulu-study-runtime:demo -f study/Dockerfile study
node study/runtime.mjs <private-runtime-dir> fixture
node study/gateway.mjs <private-runtime-dir>/config.json
```

The runtime creates two separate student containers. Login files and the assigned gateway port are written into the private runtime directory. Serve that gateway through an HTTPS proxy which preserves Host and Origin and sets X-Forwarded-Proto. Keep the origin on loopback. Stop containers with `node study/stop.mjs <private-runtime-dir>`; retain records. Supervise and time-limit both gateway and tunnel.

Open the dashboard, send a prompt, and select **研究记录 / Record**. Choose the prompt, phase, next action, and adoption level. Choose **Non-AI step** for work done without AI. **Export** downloads an optional student copy. Collection does not depend on this button. Sign in with the separate credentials in `admin.login.txt` to open `/study/admin`. The admin sees every student, full conversations, uploaded pictures, submitted reflections, and counts of prompts without reflections. **Download all** saves one JSON file with all students. Image metadata links each original and processed file to its prompt; image bytes stay in private storage and are available in the admin view. Phase is a student's completion-based selection, not a timed boundary.

## Boundaries and limitations

- Each student has a separate daemon, workspace, home, password, and seeded conversation. The gateway holds daemon credentials. Students cannot create agents or terminals, change models or modes, resume arbitrary sessions, modify permissions, forge timeline entries, or query another student's agent. Direct daemon file/MCP HTTP routes are blocked.
- Containers have a read-only root, no Linux capabilities, and CPU, memory, and process limits. The application checkout is mounted read-only. Production requires a reviewed sandbox and outbound network policy. This host's snap Docker rejected no-new-privileges; that additional constraint is not active in this demo.
- The synthetic public preview has no Codex authentication or external provider credentials. Its answers explicitly say they are fixtures. A synthetic tool-card demonstration may show a simulated shell call; it executes no shell command.
- Live mode copies only an explicitly supplied Codex auth file into private isolated homes. Set STUDY_CODEX_BINARY and STUDY_CODEX_AUTH to local paths, then run the setup with `live`. It pins the model, disables shell and web search in Codex configuration, and uses a read-only sandbox. Do not publish that runtime as an unaudited public preview. Delete the copied authentication after the private smoke test.
- Students can send text and PNG/JPEG/WebP still images. Maximum four pictures per prompt, two MiB per picture, 16 megapixels, and 50 MiB total recorded image bytes per student. The server decodes and re-encodes each picture before sending it to the provider. It retains the original and processed copy. SVG, animated images, arbitrary files, voice, and model/mode selection are unavailable. `/new` routes back to the assigned chat. Some upstream navigation actions remain visible and return access denied.
- Default quotas are 10 prompts/minute and 200/day per student. Accepted daily counts recover from disk. Maximum three browser sockets/student, 120 frames/10 seconds, and a bounded queue. Login permits 10 attempts/account/minute and 120 total/minute. Passwords use salted scrypt; sessions use HttpOnly cookies, expire after six hours, and close active sockets on logout. The server checks origins and ownership. These controls do not impose a token or money budget, stop all denial-of-service attacks, or replace production identity management.
- Questionnaires, expert review, researcher coding, spreadsheet exports, external backups, and retention controls remain unimplemented. The application records interactions made through this site. Students must report their decisions, adoption, and work performed outside it; unsaved reflection drafts are not collected.
- Conversation turns are persisted by Paseo; the recorder also keeps raw request/event logs and periodic canonical snapshots. Annotations append to a local file. Gateway restart restores records but invalidates browser login cookies. This is a single-machine demonstration; backups, durable database transactions, retention controls, and production monitoring remain.

## Verification and capacity plan

Run the focused integration tests against synthetic containers only:

```sh
STUDY_TEST_RUNTIME=<fresh-private-fixture-runtime-dir> node --test study/gateway.test.mjs study/images.test.mjs
npm run typecheck --workspace=@getpaseo/app
npm run lint -- study packages/app/src/study
```

Twelve focused tests cover isolation, tampering, automatic collection, image validation and ownership, admin roles, quotas, logout, restart recovery, and retaining archived transcripts after a provider resets its history. A browser walkthrough covers picture upload, reflection submission, automatic admin visibility without student export, admin download, and reload. Two simultaneous private real Codex text requests passed. A separate private picture test passed through the same gateway: `gpt-6.1-sol` correctly identified the synthetic cup sketch. Private smoke containers were stopped and copied authentication removed afterward. These checks do not establish capacity for 60 students. Tests append to fixture conversations; use a fresh isolated runtime for each run.

## Hosting and data flow

The current prototype runs on Jacob's desktop. An HTTPS relay on the existing Tokyo server forwards HTTP and WebSocket traffic through an encrypted reverse SSH tunnel to the loopback gateway. The relay uses a static IP and an automatically renewed trusted IP certificate. The gateway and tunnel run as persistent user services without a scheduled expiry; their private configuration stays outside this checkout. Student containers restart automatically and retain their mounted homes. The desktop must stay awake and online. The gateway serves the built Paseo web files, handles login, checks permissions and quotas, and routes each student to their own Docker container. Each container runs Paseo and, in live mode, Codex CLI. Codex sends model requests to OpenAI; responses stream back through the gateway to the browser.

The recorder checkpoints transcripts every 15 seconds and on graceful shutdown. It merges current provider history with its saved archive, so an empty provider history after a restart cannot erase previously recorded turns. Abrupt crashes can still lose output generated since the last checkpoint. Login sessions expire after six hours; students can sign in again. A permanent link does not make login cookies permanent.

The attempted 60-student fixture setup reached 36 isolated runtimes on the occupied 64 GiB desktop. Memory pressure rose sharply, and Jacob reported that RAM maxed out and he had to reboot. The 5 GiB available-memory guard did not prevent the incident. All test containers were removed. No 60-student simultaneous generation test completed, and this setup is not certified for classroom use. Do not repeat this load test on the personal desktop. Future capacity testing needs an isolated host, a hard aggregate memory limit, pressure monitoring, and an independent shutdown watchdog.

Paseo persists conversations in each private container home. The gateway writes prompt/event logs, pictures, submitted reflections, and canonical transcript snapshots in the private runtime directory. It refreshes snapshots every 15 seconds. Admin reads use the server's conversation data. No student export is needed. Desktop sleep, shutdown, or lost connectivity takes the site offline. The temporary tunnel expires with its supervised review lifetime.

Live mode pins `gpt-6.1-sol` with low reasoning effort. Copying one Codex account into separate student runtimes shares that account's allowance and provider capacity. Sixty logged-in students can have sixty conversations; only students generating responses consume generation capacity. Available allowance does not prove sixty concurrent requests will succeed. The fixture preview consumes no model allowance.

Before a classroom run:

1. Exercise 60 distinct student runtimes with mock streams for a half-day workload. Measure per-container memory, process count, CPU, socket recovery, recorder delay, and transcript completeness. Simulate disconnects and host restarts.
2. Repeat with the intended provider/account setup at 5, 15, 30, then 60 concurrent real turns. Measure queue and response latency, provider rate limits, quota consumption, failures, and recovery. Agree a usage budget before this test.
3. Have Lulu test a complete phase with students, including non-AI steps and missing annotations. Validate exports against her coding protocol and reduce recording burden.
4. Choose production authentication, storage, backup, retention, hosting and access in the students' region. Verify the selected provider's account/API terms for shared classroom use. Do not infer provider concurrency from frontend connection count.

Upstream base: getpaseo/paseo 8216e86 (Apache-2.0). The original lulu-research checkout is not required by this demo.
