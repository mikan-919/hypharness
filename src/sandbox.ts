import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Both shell commands and stdio servers use the same mounts and isolated environment.
export function sandboxCommand(workspace: string, command: string, args: string[], env: Record<string, string> = {}) {
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new Error("Sandbox requires bubblewrap");
  const shellPath = Bun.which("sh"), bunPath = Bun.which("bun");
  if (!shellPath || !bunPath) throw new Error("Shell or Bun executable not found");
  const executableDirs = [...new Set([dirname(shellPath), dirname(bunPath), dirname(process.execPath)])];
  const system = ["/nix/store", "/run/current-system/sw", "/usr", "/bin", "/lib", "/lib64", "/etc/resolv.conf", "/etc/ssl/certs"]
    .filter(existsSync).flatMap(path => ["--ro-bind", path, path]);
  const masked: string[] = [];
  function maskSecrets(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === ".env" || entry.name === "auth.json") {
        if (!entry.isFile()) throw new Error(`Cannot safely hide ${path}`);
        masked.push("--ro-bind", "/dev/null", join("/workspace", relative(workspace, path)));
      } else if (entry.isDirectory()) maskSecrets(path);
    }
  }
  maskSecrets(workspace);
  return [bwrap, "--unshare-user", "--unshare-pid", "--die-with-parent", "--clearenv",
    ...system, ...executableDirs.flatMap(path => ["--ro-bind", path, path]), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", resolve(workspace), "/workspace", ...masked,
    "--chdir", "/workspace", "--setenv", "PATH", [...executableDirs, "/run/current-system/sw/bin", "/usr/bin", "/bin"].join(":"), "--setenv", "HOME", "/tmp",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]), "--", command, ...args];
}

export function sandboxShell(workspace: string, command: string) {
  const shell = Bun.which("sh");
  if (!shell) throw new Error("Shell executable not found");
  return sandboxCommand(workspace, realpathSync(shell), ["-c", command]);
}
