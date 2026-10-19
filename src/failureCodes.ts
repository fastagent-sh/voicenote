// Which transcription failures describe the recording rather than the run.
//
// Shared by the job-state classifier (src/jobs.ts) and the desktop's failure
// wording, because they were two copies of the same regex and the copy is what
// told a user "the service cannot read this file" for an error that was ours.

/**
 * The answer will not change on a retry: 20000003 is 静音音频 (silent audio).
 */
export const NO_SPEECH = /20000003|no valid speech|silent audio/i

/**
 * The audio itself is unusable: 45000151 (不支持/无法读取的音频格式) and
 * 45000002 (空音频). Deliberately NOT every `45…` status — 45000001 is a
 * request-parameter error, which is our bug, not the file's, so it stays a
 * retryable failure instead of branding the recording unusable forever.
 */
export const UNUSABLE_AUDIO = /45000151|45000002|invalid audio|audio convert failed/i
