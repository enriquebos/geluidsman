export class GooseAntics {
  kind = ''
  private phase = 0
  private deadline = 0
  private phaseUntil = 0
  private target = { x: 0, y: 0 }
  private borrowed: HTMLElement | null = null
  private visibility = ''
  private prop: HTMLElement | null = null
  private destination: HTMLElement | null = null
  private previousDvd = { x: 0, y: 0 }
  private velocity = { x: 0, y: 0 }
  private children: { node: HTMLElement; x: number; y: number }[] = []
  private childrenAt = 0
  private broodUntil = 0
  private departure: { dx: number; dy: number; x: number; y: number } | null = null
  private bubble: HTMLElement | null = null
  private bubbleUntil = 0
  private nextBubble = 20000 + Math.random() * 20000
  get hasChildren() { return this.children.length > 0 }
  constructor(private goose: HTMLElement) {}
  private visible(selector: string) {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(node => {
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth && getComputedStyle(node).visibility !== 'hidden'
    })
  }
  private point(node: HTMLElement) { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2 - 65, y: box.y + box.height / 2 - 20 } }
  available() {
    return [
      ...(this.visible('.sound-card .sound-emoji, .sound-card .compact-emoji').length ? ['steal'] : []),
      ...(this.visible('main button:not(:disabled), .connection-bar button:not(:disabled)').length ? ['inspect'] : []),
      ...(document.querySelector('.playback-bar') ? ['trip'] : []), 'nap', ...(!this.departure && this.children.length < 4 ? ['egg'] : []),
      ...(document.querySelector('.fun-dvd') ? ['fight'] : []),
    ]
  }
  start(now: number, x: number, y: number, selected?: string) {
    if (selected === 'egg' && this.departure) return false
    this.stop()
    const choices = selected ? [] : this.available()
    this.kind = selected || choices[Math.floor(Math.random() * choices.length)]
    this.target = { x, y }; this.deadline = now + 14000
    if (this.kind === 'steal') {
      const emojis = this.visible('.sound-card .sound-emoji, .sound-card .compact-emoji')
      this.destination = emojis[Math.floor(Math.random() * emojis.length)] ?? null
      if (!this.destination) { this.stop(); return false }
      this.target = this.point(this.destination)
    } else if (this.kind === 'inspect') {
      const buttons = this.visible('main button:not(:disabled), .connection-bar button:not(:disabled)')
      this.destination = buttons[Math.floor(Math.random() * buttons.length)] ?? null
      if (!this.destination) { this.stop(); return false }
      this.target = this.point(this.destination)
    } else if (this.kind === 'trip') {
      this.destination = document.querySelector('.playback-bar')
      if (!this.destination) { this.stop(); return false }
      const box = this.destination.getBoundingClientRect(); this.target = { x: box.x + box.width / 2, y: box.y - 75 }
    } else if (this.kind === 'nap') this.target = { x: 14, y: innerHeight - 170 }
    this.goose.dataset.behavior = `${this.kind}-approach`
    return true
  }
  wake() { if (this.kind === 'nap') this.stop() }
  tick(now: number, x: number, y: number) {
    if (!this.kind) return null
    if (now >= this.deadline || this.destination && !this.destination.isConnected) { this.stop(); return null }
    const close = Math.hypot(Math.max(0, Math.min(innerWidth - 65, this.target.x)) - x, Math.max(30, Math.min(innerHeight - 95, this.target.y)) - y) < 4
    if (this.kind === 'fight') {
      const dvd = document.querySelector<HTMLElement>('.fun-dvd')
      if (!dvd) { this.stop(); return null }
      const next = this.point(dvd), dx = next.x - this.previousDvd.x, dy = next.y - this.previousDvd.y
      const bounced = this.phase === 1 && (dx * this.velocity.x < 0 || dy * this.velocity.y < 0)
      this.previousDvd = next; this.velocity = { x: dx, y: dy }
      if (bounced) { this.phase = 2; this.phaseUntil = now + 2200; this.target = { x: next.x > x ? 10 : innerWidth - 80, y: next.y > y ? 60 : innerHeight - 110 } }
      if (this.phase !== 2) { this.phase = 1; this.target = next; this.goose.dataset.behavior = 'fight-chase' }
      else { this.goose.dataset.behavior = 'fight-flee'; if (now >= this.phaseUntil) this.stop() }
    } else if (this.phase === 0 && close) {
      this.phase = 1; this.phaseUntil = now + 3200; this.goose.dataset.behavior = this.kind
      if (this.kind === 'steal') {
        this.borrowed = this.destination; this.visibility = this.borrowed!.style.visibility
        this.prop = document.createElement('div'); this.prop.className = 'goose-loot'
        this.prop.append(this.borrowed!.cloneNode(true)); this.goose.append(this.prop); this.borrowed!.style.visibility = 'hidden'
        this.target = { x: Math.max(5, Math.min(innerWidth - 80, x + (x > innerWidth / 2 ? -150 : 150))), y: Math.max(40, y - 60) }
      } else if (this.kind === 'nap') this.phaseUntil = now + 9000
      else if (this.kind === 'egg') {
        this.prop = document.createElement('div'); this.prop.className = 'goose-egg'; this.prop.textContent = '🥚'
        Object.assign(this.prop.style, { position: 'fixed', left: `${x + 15}px`, top: `${y + 65}px` }); this.goose.parentElement!.append(this.prop)
        this.phaseUntil = now + 1800
      }
    } else if (this.phase === 1 && now >= this.phaseUntil) {
      if (this.kind === 'steal') { this.phase = 2; this.target = this.point(this.destination!) }
      else if (this.kind === 'egg') {
        if (this.departure) { this.stop(); return null }
        this.prop?.remove(); this.prop = null
        const chance = Math.random(), count = Math.min(4 - this.children.length, chance < .7 ? 1 : chance < .92 ? 2 : chance < .99 ? 3 : 4)
        if (!this.children.length) this.broodUntil = now + 60000 + Math.random() * 60000
        for (let index = 0; index < count; index++) {
          const node = document.createElement('div'); node.className = 'goose-baby'
          const svg = this.goose.querySelector('svg')!.cloneNode(true) as SVGElement
          svg.querySelector('.goose-sleeping')?.remove()
          node.append(svg); this.goose.parentElement!.append(node)
          this.children.push({ node, x: Math.max(0, Math.min(innerWidth - 32, x + 15 + index * 12)), y: Math.max(0, Math.min(innerHeight - 43, y + 65)) })
        }
        this.stop()
      } else this.stop()
    } else if (this.phase === 2) {
      if (this.kind === 'steal' && close) this.stop()
    }
    return this.kind ? this.target : null
  }
  followChildren(now: number, x: number, y: number, allowBubble = false) {
    const dt = Math.min(.05, Math.max(0, (now - (this.childrenAt || now)) / 1000))
    this.childrenAt = now
    if (this.bubble && now >= this.bubbleUntil) { this.bubble.remove(); this.bubble = null }
    if (allowBubble && !this.kind && !this.bubble && now >= this.nextBubble) {
      this.bubble = document.createElement('div')
      const thought = Math.random() < .3
      this.bubble.className = `goose-bubble${thought ? ' goose-thought' : ''}`
      this.bubble.textContent = thought ? "Ik verlang naar m'n urn" : 'Honk Honk'
      this.goose.parentElement!.append(this.bubble)
      this.bubbleUntil = now + (thought ? 10000 : 2500); this.nextBubble = now + 45000 + Math.random() * 45000
    }
    if (this.bubble) {
      this.bubble.style.left = `${Math.max(8, Math.min(innerWidth - this.bubble.offsetWidth - 8, x + 35 - this.bubble.offsetWidth / 2))}px`
      this.bubble.style.top = `${Math.max(8, y - this.bubble.offsetHeight - 10)}px`
    }
    if (this.children.length && !this.departure && now >= this.broodUntil) {
      const leader = this.children[0]
      const edges = [{ distance: leader.x, dx: -1, dy: 0 }, { distance: innerWidth - leader.x, dx: 1, dy: 0 }, { distance: leader.y, dx: 0, dy: -1 }, { distance: innerHeight - leader.y, dx: 0, dy: 1 }]
      const edge = edges.reduce((best, value) => value.distance < best.distance ? value : best)
      this.departure = { dx: edge.dx, dy: edge.dy, x: leader.x, y: leader.y }
      for (const child of this.children) child.node.dataset.leaving = 'true'
    }
    if (this.departure && this.children.every(child => child.x < -40 || child.x > innerWidth + 10 || child.y < -50 || child.y > innerHeight + 10)) {
      for (const child of this.children) child.node.remove()
      this.children = []; this.departure = null; this.broodUntil = 0
    }
    const facing = this.departure?.dx || Number(this.goose.style.getPropertyValue('--goose-facing')) || 1
    let previous = { x: x + 25 - facing * 30, y: y + 55 }
    for (const [index, child] of this.children.entries()) {
      const targetX = this.departure ? index === 0 ? this.departure.dx < 0 ? -180 : this.departure.dx > 0 ? innerWidth + 180 : this.departure.x : previous.x - this.departure.dx * 26 : Math.max(0, Math.min(innerWidth - 32, previous.x - facing * 26))
      const targetY = this.departure ? index === 0 ? this.departure.dy < 0 ? -180 : this.departure.dy > 0 ? innerHeight + 180 : this.departure.y : previous.y - this.departure.dy * 26 : Math.max(0, Math.min(innerHeight - 43, previous.y))
      const dx = targetX - child.x, dy = targetY - child.y, distance = Math.hypot(dx, dy)
      const step = Math.min(distance, 190 * dt)
      if (distance > .5) { child.x += dx / distance * step; child.y += dy / distance * step }
      child.node.style.transform = `translate3d(${child.x}px,${child.y}px,0)`
      child.node.style.setProperty('--goose-facing', String(Math.abs(dx) > 1 ? dx < 0 ? -1 : 1 : facing))
      previous = child
    }
  }
  clear() {
    this.stop()
    for (const child of this.children) child.node.remove()
    this.children = []; this.childrenAt = 0; this.broodUntil = 0; this.departure = null
    this.bubble?.remove(); this.bubble = null
  }
  stop() {
    if (this.borrowed) this.borrowed.style.visibility = this.visibility
    this.prop?.remove(); this.prop = null; this.borrowed = null; this.destination = null
    this.kind = ''; this.phase = 0; delete this.goose.dataset.behavior
  }
}
