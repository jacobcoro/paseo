# Lulu design research demo

This fork keeps Paseo's dashboard, composer, streamed timeline, Markdown renderer, and tool cards. The study layer adds student login, an isolated conversation, research annotations, non-AI steps, and a JSON export of the complete canonical timeline. It does not calculate cognitive offloading or Bloom categories. Those need a separate researcher coding process.

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

Open the dashboard, send a prompt, and select **研究记录 / Record**. Choose the prompt, phase, next action, and adoption level. Choose **Non-AI step** for work done without AI. **Export** downloads the student's transcript and annotations. Phase is a student's completion-based selection, not a timed boundary.

## Boundaries and limitations

- Each student has a separate daemon, workspace, home, password, and seeded conversation. The gateway holds daemon credentials. Students cannot create agents or terminals, change models or modes, resume arbitrary sessions, modify permissions, forge timeline entries, or query another student's agent. Direct daemon file/MCP HTTP routes are blocked.
- Containers have a read-only root, no Linux capabilities, and CPU, memory, and process limits. The application checkout is mounted read-only. Production requires a reviewed sandbox and outbound network policy. This host's snap Docker rejected no-new-privileges; that additional constraint is not active in this demo.
- The synthetic public preview has no Codex authentication or external provider credentials. Its answers explicitly say they are fixtures. A synthetic tool-card demonstration may show a simulated shell call; it executes no shell command.
- Live mode copies only an explicitly supplied Codex auth file into private isolated homes. Set STUDY_CODEX_BINARY and STUDY_CODEX_AUTH to local paths, then run the setup with `live`. It pins the model, disables shell and web search in Codex configuration, and uses a read-only sandbox. Do not publish that runtime as an unaudited public preview. Delete the copied authentication after the private smoke test.
- The first demo supports text. Attachments, voice, researcher web administration, questionnaires, expert review, coding workflows, and spreadsheet exports are not implemented. Some upstream navigation actions remain visible and return access denied.
- Conversation turns are persisted by Paseo; the recorder also keeps raw request/event logs and periodic canonical snapshots. Annotations append to a local file. Gateway restart restores records but invalidates browser login cookies. This is a single-machine demonstration; backups, durable database transactions, retention controls, and production monitoring remain.

## Verification and capacity plan

Run the focused integration tests against synthetic containers only:

```sh
STUDY_TEST_RUNTIME=<private-runtime-dir> node --test study/gateway.test.mjs
npm run typecheck --workspace=@getpaseo/app
npm run lint -- study packages/app/src/study
```

The demo has passed two simultaneous real Codex requests and six gateway integration tests. That verifies the connection and isolation, not 60 simultaneous students.

Before a classroom run:

1. Exercise 60 distinct student runtimes with mock streams for a half-day workload. Measure per-container memory, process count, CPU, socket recovery, recorder delay, and transcript completeness. Simulate disconnects and host restarts.
2. Repeat with the intended provider/account setup at 5, 15, 30, then 60 concurrent real turns. Measure queue and response latency, provider rate limits, quota consumption, failures, and recovery. Agree a usage budget before this test.
3. Have Lulu test a complete phase with students, including non-AI steps and missing annotations. Validate exports against her coding protocol and reduce recording burden.
4. Choose production authentication, storage, backup, retention, hosting and access in the students' region. Verify the selected provider's account/API terms for shared classroom use. Do not infer provider concurrency from frontend connection count.

Upstream base: getpaseo/paseo 8216e86 (Apache-2.0). The original lulu-research checkout is not required by this demo.
