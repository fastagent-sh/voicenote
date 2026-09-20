#!/usr/bin/env node
// The `vn` command: argument parsing on top of core.ts, nothing else.
import { cac } from 'cac'
import {
  VERSION,
  configGet, configSet, doctor, ensureScheduler, forgetRecording, importRecording,
  installScheduler, jobsList, lastMeeting, listMeetings, loginChatGPT, openTarget,
  ignoreJob, printSchedulerStatus, regenerateNotes, retryRecording, runPipeline, showErrors, showLog,
  uninstallScheduler, upgradeSelf,
} from './core.ts'

// ────────────────────────────────────────────────────────────────────────────
// CLI commands
// ────────────────────────────────────────────────────────────────────────────

const cli = cac('vn')

cli.command('run [file]', 'Scan recorder and process recordings, or process one audio file by path (Volcano ASR + pi notes)')
  .option('--mode <mode>', 'Output mode: notes (default) | transcript', { default: 'notes' })
  .option('--latest', 'Only process newest eligible recording')
  .option('--force', 'Reprocess already processed recordings')
  .option('--dry-run', 'Do not copy / transcribe / write files')
  .option('--pdf', 'Also render notes to PDF (only meaningful for --mode notes)')
  .option('--verbose', 'Print per-file skip details during scan')
  .action(runPipeline)

cli.command('list', 'List notes in a month')
  .option('--month <YYYY-MM>', 'Month to list (default: current month)')
  .action(listMeetings)

cli.command('last', 'Print summary of most recent processed recording').action(lastMeeting)
cli.command('jobs', 'Show every recording\'s processing status (running, queued, done, failed, gave up, filtered)')
  .option('--limit <n>', 'How many to list', { default: 30 })
  .option('--json', 'Output as JSON (for the GUI)')
  .action((opts: { limit?: number; json?: boolean }) => jobsList(opts))


cli.command('open [target]', 'Open notes dir, config dir (`config`), logs dir (`logs`), or a note matching the slug').action((target?: string) => openTarget(target))

cli.command('import <file>', 'Copy one audio file into the durable manual-import queue')
  .option('--json', 'Output structured status (for the GUI)')
  .action((file: string, opts: { json?: boolean }) => importRecording(file, opts))
cli.command('forget <key>', 'Drop a recording\'s job record so it is queued again (a saved transcript on disk is still reused)').action((key: string) => forgetRecording(key))
cli.command('retry <id>', 'Requeue one failed recording while retaining saved outputs').action((id: string) => retryRecording(id))
cli.command('ignore <id>', 'Set a recording aside so no run picks it up again').action((id: string) => ignoreJob(id))
cli.command('regenerate <id>', 'Write the notes again from the saved transcript (no new transcription cost)').action((id: string) => regenerateNotes(id))

cli.command('log', 'Print the daily log (today by default)')
  .option('--lines <n>', 'How many trailing lines to print', { default: 30 })
  .option('-f, --follow', 'Follow the log live (tail -F)')
  .option('--err', 'Also include launchd.err.log')
  .option('--date <YYYY-MM-DD>', 'Show a specific day instead of today')
  .action(showLog)

cli.command('errors', 'Show recent ERROR lines from daily logs').option('--lines <n>', 'How many lines to print', { default: 20 }).action(showErrors)

cli.command('upgrade', 'Upgrade to the latest published version via npm i -g').action(upgradeSelf)

cli.command('doctor', 'Check environment')
  .option('--json', 'Output structured status as JSON (for the GUI)')
  .action((opts: { json?: boolean }) => doctor(opts))
cli.command('login', 'Sign in to ChatGPT (Codex OAuth) for the pi summary backend')
  .option('--json', 'Emit machine-readable JSON events (for the GUI client)')
  .option('--device-code', 'Use the device-code flow instead of the browser callback (needs the ChatGPT security-settings opt-in)')
  .action((opts: { json?: boolean; deviceCode?: boolean }) => loginChatGPT(opts))
cli.command('config <action>', 'Read/write file-based config. action: get (print JSON) | set (write from stdin JSON)')
  .action((action: string) => {
    if (action === 'set') return configSet()
    if (action === 'get') return configGet()
    console.error(`Unknown config action '${action}'. Use: vn config get | vn config set`)
    process.exitCode = 1
  })
cli.command('install-launch-agent', 'Install background scheduler (mac LaunchAgent / Windows Task Scheduler)')
  .option('--load', 'Also (re)load/start it immediately')
  .action((opts: { load?: boolean }) => installScheduler(opts))
cli.command('ensure-launch-agent', 'Install the background scheduler when missing or stale')
  .option('--force', 'Reinstall even when the scheduler is current')
  .action((opts: { force?: boolean }) => ensureScheduler(!!opts.force))
cli.command('uninstall-launch-agent', 'Remove the background scheduler').action(uninstallScheduler)
cli.command('status', 'Print background scheduler status').action(printSchedulerStatus)

cli.help()
cli.version(VERSION)
// Run the command ourselves so a thrown error (bad config, unreadable state
// file) reaches the user as the one line it is, not as a bun stack trace.
const parsed = cli.parse(process.argv, { run: false })
// cac prints --help/--version itself and then reports no matched command; any
// OTHER unmatched invocation is a typo, which it would ignore in silence.
if (!cli.matchedCommand && !parsed.options.help && !parsed.options.version) {
  if (parsed.args.length) console.error(`vn: unknown command '${parsed.args[0]}'`)
  cli.outputHelp()
  process.exit(parsed.args.length ? 1 : 0)
}
try {
  await cli.runMatchedCommand()
} catch (e: any) {
  console.error(`vn: ${e?.message || e}`)
  if (process.env.VN_DEBUG) console.error(e?.stack || '')
  process.exit(1)
}
