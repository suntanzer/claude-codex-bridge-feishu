import { execFile } from 'node:child_process';

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input != null) {
      child.stdin?.end(options.input);
    }
  });
}

function stripAnsi(text) {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

export async function tmux(args, options = {}) {
  return execFileText('tmux', args, options);
}

export async function captureTmuxPane(sessionName, start = '-120') {
  const { stdout } = await tmux(['capture-pane', '-pJ', '-S', start, '-t', sessionName]);
  return stripAnsi(stdout);
}

export async function sendPromptToTmux(sessionName, text) {
  await tmux(['send-keys', '-t', sessionName, 'C-u']);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await tmux(['send-keys', '-t', sessionName, '-l', '--', text]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await tmux(['send-keys', '-t', sessionName, 'C-m']);
}
