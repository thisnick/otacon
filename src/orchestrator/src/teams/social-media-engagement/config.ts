export interface AgentConfig {
  role: string
  promptFile: string
  model: string
  conversation: 'persistent' | 'ephemeral'
}

export interface TeamConfig {
  name: string
  description: string
  lead: string
  agents: AgentConfig[]
}

export const socialMediaEngagement: TeamConfig = {
  name: 'social-media-engagement',
  description: 'Operates a social media account for warming/engagement',
  lead: 'engagement-lead',
  agents: [
    {
      role: 'engagement-lead',
      promptFile: 'engagement-lead.md',
      model: 'alibaba/qwen3.6-plus',
      conversation: 'persistent',
    },
  ],
}
