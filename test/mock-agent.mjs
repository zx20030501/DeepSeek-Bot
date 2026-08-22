export function withMockSession(agent) {
  const events = []
  const session = {
    get events() { return events },
    get seq() { return events.length },
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
  }
  agent.session = session
  agent.whenIdle ??= async () => {}
  const followup = agent.followup.bind(agent)
  agent.followup = (...args) => {
    const latestTurn = events.reduce((latest, event) => Math.max(latest, Number(event.data?.turn ?? 0)), 0)
    agent.__mockTurn = latestTurn + 1
    session.append('turn/start', { turn: agent.__mockTurn })
    agent.status = 'running'
    return followup(...args)
  }
  return agent
}

export function emitMockAgentEvent(gateway, agent, type, data) {
  if (!Number.isSafeInteger(agent.__mockTurn)) throw new Error(`mock Agent has no active turn for ${type}`)
  const eventData = type === 'assistant/message'
    ? { turn: agent.__mockTurn, step: 1, ...data }
    : { turn: agent.__mockTurn, ...data }
  const event = agent.session.append(type, eventData)
  if (type === 'turn/end') agent.status = 'idle'
  gateway.onSessionEvent(agent, event)
  return event
}
