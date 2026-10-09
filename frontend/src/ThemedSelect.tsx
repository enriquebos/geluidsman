import { Children, isValidElement, ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { SearchSelect } from './SearchSelect'

type Props = { children: ReactNode; value?: string | number; onChange: (value: string) => void; disabled?: boolean; 'aria-label'?: string }
function text(value: ReactNode): string {
  return Children.toArray(value).map(child => isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child)).join('')
}
export function ThemedSelect({ children, value, onChange, disabled, 'aria-label': accessibleLabel }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState(accessibleLabel || 'Choose option')
  useLayoutEffect(() => { if (!accessibleLabel) setLabel(root.current?.closest('label')?.firstChild?.textContent?.trim() || 'Choose option') }, [accessibleLabel])
  const options = Children.toArray(children).filter(isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>).map(option => ({ id: String(option.props.value ?? text(option.props.children)), name: text(option.props.children), disabled: option.props.disabled }))
  return <div className="themed-select" ref={root}><SearchSelect label={label} hideLabel value={String(value ?? '')} onChange={onChange} options={options} allowEmpty={false} searchable={false} disabled={disabled} /></div>
}
