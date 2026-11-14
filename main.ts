// The forge entrypoint: boot the server on an ephemeral port, announce the
// port to the trial environment, then wait for its done signal and exit 0.
// All of the forge itself lives in app.ts; this file is only the lifecycle
// the trial harness contracts with.

import { createForgeServer } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function announceAndWait(port: number): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return; // No trial environment: serve until stopped.
  const base = envUrl.replace(/\/+$/, '');
  // Register the port; the environment records the address the request
  // came from and dials it back. Retry briefly in case it is still booting.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.status === 200 || reply.status === 409) break;
    } catch {
      // The environment is not up yet; try again shortly.
    }
    await sleep(200);
  }
  // Long-poll the done endpoint until the suite has finished.
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`);
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A transient failure says nothing about the suite's progress.
    }
    await sleep(250);
  }
}

const server = createForgeServer();
await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
await announceAndWait(port);
process.exit(0);
