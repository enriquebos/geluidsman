type Point = { x: number; y: number }
type Mode = '' | 'notice' | 'stalk' | 'chase' | 'investigate' | 'peck' | 'rest' | 'lose-interest' | 'look' | 'recoil' | 'skid' | 'look-around' | 'inspect-button' | 'button-peck'

export class GooseCursorInterest {
  mode: Mode = ''
  present = false
  facing = 1
  private pointer = { x: 0, y: 0 }
  private speed = 0
  private movedAt = 0
  private sampledAt = 0
  private until = 0
  private remaining = 20000 + Math.random() * 20000
  private previous = 0
  private reactionAfter = 0
  private caught = false
  private button: HTMLElement | null = null
  private destination: Point = { x: 0, y: 0 }
  track(x: number, y: number, now: number) {
    if (!this.present) this.previous = now
    const distance = Math.hypot(x - this.pointer.x, y - this.pointer.y)
    const elapsed = now - this.sampledAt
    this.speed = this.present && elapsed > 0 ? distance * 1000 / elapsed : 0
    if (distance > 2 || !this.present) this.movedAt = now
    this.pointer = { x, y }; this.sampledAt = now; this.present = true
  }
  leave() { const active = Boolean(this.mode); this.present = false; this.mode = ''; this.button = null; if (active) this.remaining = 20000 + Math.random() * 20000; return active }
  tick(now: number, x: number, y: number, committed: boolean) {
    const elapsed = this.previous ? Math.max(0, now - this.previous) : 0
    this.previous = now
    if (this.present && !this.mode) this.remaining = Math.max(0, this.remaining - elapsed)
    if (!this.present || committed) return null
    const distance = Math.hypot(this.pointer.x - (x + 55), this.pointer.y - (y + 15))
    if (!this.mode && this.remaining === 0) {
      this.mode = now - this.movedAt > 2500 && Math.random() < .35 ? 'investigate' : 'notice'
      this.until = now + (this.mode === 'notice' ? 600 : 8000)
      this.destination = { x: this.pointer.x - 75, y: this.pointer.y + 20 }
    } else if (!this.mode && now >= this.reactionAfter && now - this.sampledAt < 150 && distance < 95) {
      this.mode = this.speed > 650 ? 'recoil' : this.speed < 100 ? 'look' : ''
      if (this.mode) {
        this.until = now + 650; this.reactionAfter = now + 8000
        this.destination = this.mode === 'recoil' ? { x: x + (x + 55 > this.pointer.x ? 70 : -70), y: y + 30 } : { x, y }
      }
    }
    if (this.mode === 'chase' && distance < 65) this.caught = true
    if (this.mode === 'notice' || this.mode === 'look') this.facing = this.pointer.x < x + 55 ? -1 : 1
    if (this.mode === 'investigate' && Math.hypot(this.destination.x - x, this.destination.y - y) < 4) this.until = now
    if (this.mode && now >= this.until) {
      if (this.mode === 'notice') { this.mode = 'stalk'; this.until = now + 900 }
      else if (this.mode === 'stalk') { this.mode = 'chase'; this.caught = false; this.until = now + 3000 + Math.random() * 3000 }
      else if (this.mode === 'investigate') { this.mode = Math.random() < .5 ? 'peck' : 'rest'; this.until = now + 900 }
      else if (this.mode === 'chase' && !this.caught) {
        this.mode = 'skid'; this.until = now + 450; this.destination = { x: x + this.facing * 25, y }
        this.remaining = 20000 + Math.random() * 20000
      } else if (this.mode === 'skid') { this.mode = 'look-around'; this.until = now + 700; this.destination = { x, y } }
      else if (this.mode === 'look-around') {
        this.button = Array.from(document.querySelectorAll<HTMLElement>('main button:not(:disabled)')).filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.top >= 0 && box.bottom < innerHeight && box.left >= 0 && box.right <= innerWidth && getComputedStyle(node).visibility !== 'hidden' && Math.hypot(box.x - x, box.y - y) < 250 }).sort((a, b) => Math.hypot(a.getBoundingClientRect().x - x, a.getBoundingClientRect().y - y) - Math.hypot(b.getBoundingClientRect().x - x, b.getBoundingClientRect().y - y))[0] || null
        this.mode = this.button ? 'inspect-button' : 'lose-interest'; this.until = now + (this.button ? 2000 : 900)
        if (this.button) { const box = this.button.getBoundingClientRect(); this.destination = { x: box.x - 40, y: box.y + 10 } }
        else this.destination = { x: x - 100, y: y + 50 }
      } else if (this.mode === 'inspect-button') { this.mode = 'button-peck'; this.until = now + 600; this.destination = { x, y } }
      else if (['chase', 'peck', 'rest', 'button-peck'].includes(this.mode)) {
        this.mode = 'lose-interest'; this.until = now + 900
        this.destination = { x: x + (x > this.pointer.x ? 100 : -100), y: y + 50 }
        this.remaining = 20000 + Math.random() * 20000
      } else { this.mode = ''; this.reactionAfter = now + 8000; return null }
    }
    if (this.mode === 'chase' || this.mode === 'stalk') this.destination = { x: this.pointer.x - 75, y: this.pointer.y + 20 }
    if (this.mode === 'notice') this.destination = { x, y }
    return this.mode ? this.destination : null
  }
}
