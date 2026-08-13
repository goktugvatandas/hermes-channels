export type StudioSection = 'identity' | 'model' | 'behavior' | 'skills' | 'workspace' | 'advanced'

const SECTIONS: Array<{ id: StudioSection; label: string; icon: string }> = [
  { id: 'identity', label: 'Identity', icon: 'account' },
  { id: 'model', label: 'Model', icon: 'symbol-method' },
  { id: 'behavior', label: 'Behavior', icon: 'git-compare' },
  { id: 'skills', label: 'Skills', icon: 'extensions' },
  { id: 'workspace', label: 'Workspace', icon: 'folder' },
  { id: 'advanced', label: 'Advanced', icon: 'settings-gear' },
]

export function StudioSectionNav({ section, onSelect }: { section: StudioSection; onSelect(section: StudioSection): void }) {
  return (
    <nav aria-label="Agent settings" className="grid content-start gap-1 border-r border-(--ui-stroke-secondary) px-2 py-4">
      {SECTIONS.map((item) => <button aria-current={section === item.id ? 'page' : undefined} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${section === item.id ? 'bg-(--ui-accent)/10 font-medium text-(--ui-accent)' : 'text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary) hover:text-foreground'}`} key={item.id} onClick={() => onSelect(item.id)} title={item.label} type="button"><span aria-hidden="true" className={`codicon codicon-${item.icon} shrink-0`} /><span className="hidden truncate @3xl:inline">{item.label}</span></button>)}
    </nav>
  )
}
