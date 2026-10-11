import type { Job, Run } from '../types'

// GitHub Actions, as the `gh` CLI reports it as JSON: the hooks module runs
// the commands in the repository itself and hands their output here.

/** The fields asked of `gh run list --json`. */
export const RUN_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,event,createdAt,url'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function parsed(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** `gh run list --json <RUN_FIELDS>`, read: the newest first, as `gh` lists them. */
export function parseRuns(json: string): Run[] {
  const value = parsed(json)

  return (Array.isArray(value) ? value : []).flatMap(one => {
    const run = record(one)
    const url = text(run.url)

    return typeof run.databaseId === 'number'
      ? [
          {
            id: run.databaseId,
            workflow: text(run.workflowName),
            title: text(run.displayTitle),
            status: text(run.status).toLowerCase(),
            conclusion: text(run.conclusion).toLowerCase(),
            event: text(run.event),
            createdAt: text(run.createdAt),
            // Only an https address is ever handed to `open`.
            url: /^https:\/\//.test(url) ? url : '',
          },
        ]
      : []
  })
}

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']

/** How a run or a job stands, in the four ways a row is coloured. */
export function standingOf(one: { status: string; conclusion: string }): 'passed' | 'failed' | 'running' | 'idle' {
  if (one.status !== 'completed') return 'running'
  if (one.conclusion === 'success') return 'passed'

  return FAILED.includes(one.conclusion) ? 'failed' : 'idle'
}

/** `gh run view <id> --json jobs`, read: each job and the first step it failed at. */
export function parseJobs(json: string): Job[] {
  return (Array.isArray(record(parsed(json)).jobs) ? (record(parsed(json)).jobs as unknown[]) : []).map(one => {
    const job = record(one)
    const steps = Array.isArray(job.steps) ? job.steps.map(record) : []
    const failed = steps.find(step => FAILED.includes(text(step.conclusion).toLowerCase()))

    return {
      name: text(job.name),
      status: text(job.status).toLowerCase(),
      conclusion: text(job.conclusion).toLowerCase(),
      failedStep: text(failed?.name),
    }
  })
}

/** What to ask of Claude about a run that failed: where it broke and how to read why. */
export function toRunPrompt(run: Run, branch: string, jobs: readonly Job[]): string {
  const broken = jobs
    .filter(job => standingOf(job) === 'failed')
    .map(job => `- job "${job.name}"${job.failedStep === '' ? '' : `, step "${job.failedStep}"`}`)

  return [
    `The GitHub Actions run "${run.workflow}" failed on ${branch}: ${run.title}`,
    run.url,
    ...(broken.length > 0 ? ['', 'Failed:', ...broken] : []),
    '',
    `Read the failing output with \`gh run view ${run.id} --log-failed\`, find the cause, and fix it.`,
  ].join('\n')
}
