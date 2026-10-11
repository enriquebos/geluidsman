const weights: Record<string, number> = { wander: 5, hop: 2, doodle: 3, steal: 2, inspect: 2, trip: 1, nap: 2, egg: 1, fight: 2 }

export class GooseActivities {
  private history: string[] = []
  choose(available: string[]) {
    const choices = ['wander', 'hop', 'doodle', ...available].map(kind => ({ kind, weight: weights[kind] * (this.history.includes(kind) ? .12 : 1) }))
    let point = Math.random() * choices.reduce((total, choice) => total + choice.weight, 0)
    const selected = choices.find(choice => { point -= choice.weight; return point < 0 })!.kind
    this.history = [...this.history.slice(-2), selected]
    return selected
  }
}
