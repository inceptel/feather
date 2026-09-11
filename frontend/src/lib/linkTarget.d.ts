export type LinkTarget = { kind: 'invalid' } | { kind: 'anchor', hash: string } | { kind: 'web', href: string } | { kind: 'file', path: string, relative?: boolean, line?: number, fragment?: string }
export function linkTarget(input: string | null | undefined, cwd?: string | null, pathname?: string): LinkTarget
export function addHeadingIds(root: ParentNode): void
