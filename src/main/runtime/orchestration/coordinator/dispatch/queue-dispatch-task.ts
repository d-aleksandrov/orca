import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'

/** One mailbox message per Dispatch; the existing delivery lane owns the pointer and retries. */
export function queueDispatchTask(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatch: DispatchContextRow
  from: string
  preamble: string
}): void {
  const id = `msg_task_${args.dispatch.id}`
  const mailbox = `dispatch:${args.dispatch.id}`
  if (!args.db.getMessageById(id)) {
    args.db.insertMessage({
      id,
      from: args.from,
      to: mailbox,
      subject: 'Task',
      body: args.preamble,
      runId: args.dispatch.run_id
    })
  }
  args.runtime.notifyMessageArrived(mailbox, 'status')
}
