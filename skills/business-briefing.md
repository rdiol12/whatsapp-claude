# Nightly Business Briefing

Multi-persona AI council analyzes business signals and produces ranked recommendations.

## Setup
```
cd skills/business-briefing && npm install
```
Requires: `GEMINI_API_KEY`

## Usage
```
node scripts/run.js
node scripts/run.js --signals path/to/signals.json
```

### Signal format
```json
[
  {"source": "youtube", "signal_name": "daily_views", "value": 1500, "confidence": 90, "direction": "up", "category": "content"},
  {"source": "crm", "signal_name": "new_contacts", "value": 5, "confidence": 85, "direction": "up", "category": "business"}
]
```

## How It Works
1. Collects signals from configured sources
2. **LeadAnalyst** drafts 5-10 recommendations with scores
3. **4 reviewers** critique in parallel (GrowthStrategist, RevenueGuardian, SkepticalOperator, TeamDynamicsArchitect)
4. **CouncilModerator** reconciles into consensus
5. Recommendations ranked by: impact (40%) + confidence (35%) + ease (25%)
6. "Publish now" recommendations auto-filtered

Weights are configurable in the policy table and adjust via feedback.
