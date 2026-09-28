// cron-args.mjs — cron 任务 → pi CLI 参数（纯函数，无副作用，可独立单测）
export function cronPiArgs(job) {
  // Must be flags only. spawn() already prepends PI_CLI; putting it here makes
  // argv `node cli.js cli.js -p ...` and pi treats the extra path as the prompt.
  const args = ['-p', String(job.prompt).slice(0, 8000)];
  if (job.model) args.push('--model', job.model);
  return args;
}
