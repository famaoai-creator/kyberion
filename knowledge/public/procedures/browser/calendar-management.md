---
title: "Procedure: Calendar Management via Browser"
tags: [capability, browser, procedure, calendar, scheduling]
importance: 7
author: Ecosystem Architect
last_updated: 2026-04-14
kind: capability
scope: global
authority: recipe
phase: [execution]
role_affinity: [ceo, executive_assistant, sovereign_concierge]
applies_to: [browser-actuator]
owner: sovereign_concierge
status: active
---

# Procedure: Calendar Management via Browser

## 1. Goal
View, create, and modify calendar events through browser automation.
Supports Google Calendar, Outlook Web, and other browser-accessible calendar systems.

## 2. Dependencies
- **Actuator**: `browser-actuator`
- **Authentication**: `pause_for_operator` for initial login, then `export_session_handoff` for session persistence

## 3. Operations

### View Today's Schedule
```json
[
  { "type": "capture", "op": "goto", "params": { "url": "https://calendar.google.com", "waitUntil": "networkidle" } },
  { "type": "capture", "op": "snapshot", "params": { "export_as": "calendar_snapshot" } },
  { "type": "capture", "op": "screenshot", "params": { "path": "evidence/calendar/today.png", "export_as": "calendar_screenshot" } }
]
```

### Check Availability for Date Range
```json
[
  { "type": "capture", "op": "goto", "params": { "url": "https://calendar.google.com/calendar/r/week/{{target_date}}" } },
  { "type": "capture", "op": "snapshot", "params": { "export_as": "week_view" } }
]
```

### Create New Event
```json
[
  { "type": "apply", "op": "click_ref", "params": { "ref": "@create_button" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@title_input", "text": "{{event_title}}" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@date_input", "text": "{{event_date}}" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@time_input", "text": "{{event_time}}" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@guest_input", "text": "{{guest_email}}" } },
  { "type": "apply", "op": "click_ref", "params": { "ref": "@save_button" } }
]
```

### Reschedule Event
```json
[
  { "type": "apply", "op": "click_ref", "params": { "ref": "@event_element" } },
  { "type": "apply", "op": "click_ref", "params": { "ref": "@edit_button" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@date_input", "text": "{{new_date}}" } },
  { "type": "apply", "op": "fill_ref", "params": { "ref": "@time_input", "text": "{{new_time}}" } },
  { "type": "apply", "op": "click_ref", "params": { "ref": "@save_button" } }
]
```

### Session Persistence
After initial human authentication:
```json
[
  { "type": "capture", "op": "export_session_handoff", "params": { "path": "active/shared/tmp/browser/calendar-session.json", "target_url": "https://calendar.google.com", "export_as": "calendar_session" } }
]
```

For subsequent sessions:
```json
[
  { "type": "apply", "op": "import_session_handoff", "params": { "path": "active/shared/tmp/browser/calendar-session.json", "target_url": "https://calendar.google.com", "reload_after_import": true } }
]
```

## 4. Typical CEO Workflow

### 採用面接スケジュール管理
1. Snapshot calendar to check available slots
2. LLM determines best time slots considering existing meetings
3. Create interview event with candidate and interviewer emails
4. Confirm event details

### 会議の調整
1. View week schedule
2. Identify conflicting meetings
3. Propose reschedule options
4. Apply changes after confirmation

## 5. Safety
- Event creation and modification require user confirmation before save
- Session handoff data is stored securely (not in public tier)
- Calendar screenshots are evidence-tier artifacts
