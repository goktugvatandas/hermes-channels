import { useState } from 'react'

interface ApprovalCardProps {
  approvalId: string
  prompt: string
  onResolve(decision: 'approve' | 'reject', note: string): Promise<void>
}

export function ApprovalCard({ approvalId: _approvalId, prompt, onResolve }: ApprovalCardProps) {
  const [note, setNote] = useState('')
  const [resolved, setResolved] = useState(false)
  async function resolve(decision: 'approve' | 'reject') {
    await onResolve(decision, note)
    setResolved(true)
  }
  return (
    <fieldset aria-label="Approval required" className="grid gap-2 rounded border border-amber-500/50 p-2" disabled={resolved}>
      <legend className="px-1 text-xs font-semibold">Approval required</legend>
      <p className="text-xs">{prompt}</p>
      <label className="grid gap-1 text-xs">Approval note<input className="rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1" onChange={(event) => setNote(event.target.value)} value={note} /></label>
      <div className="flex gap-2"><button onClick={() => void resolve('approve')} type="button">Approve</button><button onClick={() => void resolve('reject')} type="button">Reject</button></div>
    </fieldset>
  )
}
