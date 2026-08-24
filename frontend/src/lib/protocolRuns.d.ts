import type { AdvisoryLaunchInput, ProtocolEvidenceSnapshot, ProtocolRunSnapshot, ProtocolSeatSnapshot, ProtocolVerdict } from '../api'

export interface ProtocolRunsState {
  byId: Record<string, ProtocolRunSnapshot>
  order: string[]
}

export const PROTOCOL_RUN_LIMIT: number
export const COUNCIL_MOBILE_BREAKPOINT: number
export const DEFAULT_ADVISORY_INPUT: Readonly<Required<Pick<AdvisoryLaunchInput, 'protocol' | 'candidateCount' | 'roleMode' | 'timeoutMs'>>>

export function createProtocolRunsState(): ProtocolRunsState
export function reduceProtocolRunSnapshot(state: ProtocolRunsState, incoming: ProtocolRunSnapshot): ProtocolRunsState
export function replaceProtocolRuns(runs: ProtocolRunSnapshot[]): ProtocolRunsState
export function orderedProtocolRuns(state: ProtocolRunsState): ProtocolRunSnapshot[]
export function advisoryLaunchBody(input: AdvisoryLaunchInput): AdvisoryLaunchInput
export function advisoryRoles(candidateCount: number, roleMode?: 'diverse' | 'neutral'): string[]
export function protocolSeatId(seat: ProtocolSeatSnapshot): string
export function protocolEvidenceId(evidence: ProtocolEvidenceSnapshot): string
export function candidateSeats(run: ProtocolRunSnapshot): ProtocolSeatSnapshot[]
export function judgeSeats(run: ProtocolRunSnapshot): ProtocolSeatSnapshot[]
export function protocolVerdict(run: ProtocolRunSnapshot): ProtocolVerdict | null
export function protocolRunView(run: ProtocolRunSnapshot): {
  state: ProtocolRunSnapshot['status']
  statusLabel: string
  summary: string
  stage: 'candidates' | 'judge'
  isActive: boolean
  isTerminal: boolean
  candidates: ProtocolSeatSnapshot[]
  judges: ProtocolSeatSnapshot[]
  counts: { total: number; successful: number; failed: number; complete: number; running: number }
  candidateEvidence: ProtocolEvidenceSnapshot[]
  failures: ProtocolSeatSnapshot[]
  verdict: ProtocolVerdict | null
  disagreementCount: number
  stages: Array<{ id: 'candidates' | 'judge'; label: string; status: string }>
}
export function protocolSeatView(run: ProtocolRunSnapshot, seat: ProtocolSeatSnapshot): {
  id: string
  role: string
  status: string
  statusLabel: string
  ompChildId: string | null
  reason: string
  evidence: ProtocolEvidenceSnapshot[]
}
export function protocolSeatAgentTarget(seat: ProtocolSeatSnapshot, availableAgentIds: ReadonlySet<string>): string | null
export function verdictSections(run: ProtocolRunSnapshot): {
  recommendation: string
  confidence: string
  disagreements: ProtocolVerdict['disagreements']
  ranking: ProtocolVerdict['ranking']
  citedEvidenceIds: string[]
} | null
export function activeProtocolRuns(runs: ProtocolRunSnapshot[]): ProtocolRunSnapshot[]
export function historicalProtocolRuns(runs: ProtocolRunSnapshot[]): ProtocolRunSnapshot[]
export function runsForInvocation(runs: ProtocolRunSnapshot[], invocationMessageId: string): ProtocolRunSnapshot[]
