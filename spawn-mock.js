// Spawns the 39321 mock upstream as a DETACHED child (stdio:ignore) so it
// survives this launcher's exit — then the launcher returns immediately.
// This is the same spawn pattern e2e-external.js uses for its throwaway broker.
const { spawn } = require("child_process");
const path = require("path");
const child = spawn(process.execPath, [path.join(__dirname, "test-upstream.js")], {
  stdio: "ignore",
  detached: true,
  cwd: __dirname,
});
child.unref();
console.log("mock 39321 spawned (detached) pid=" + child.pid);
