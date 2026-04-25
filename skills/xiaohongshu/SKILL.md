# Xiaohongshu (小红书/Red Note) Automation Skill

Automate interactions with the Xiaohongshu app using the otacon CLI.

## Overview

Xiaohongshu is a Chinese social media platform (Little Red Book) known as "Red Note" internationally. This skill documents everything we learned about automating it.

## App Details

- **Package name**: `com.xingin.xhs`
- **Common APK**: `xhs-9.26.0.apkm` (APKMirror split bundle)

## Installation

```bash
cd /Users/nick/code/otacon
pnpm cli app install /path/to/xhs-9.26.0.apkm
```

The CLI automatically detects `.apkm` files and extracts split APKs before installing via `adb install-multiple`.

---

## Account Signup Flow

### 1. Launch and Accept Privacy & Terms

```bash
# Launch app
pnpm cli app launch com.xingin.xhs
sleep 2

# CRITICAL: Always take snapshot first to get current refs
pnpm cli snapshot

# Look for "Agree" button in the snapshot output
# Tap the button (ref will be something like e18, but ALWAYS verify from snapshot)
pnpm cli tap <ref_from_snapshot>
```

### 2. Phone Number Sign-Up

**First, get the phone number from the device info**:

```bash
# Check current phone number assigned to this device
pnpm cli info | grep phone_number
# Output example: "phone_number  +12139230333"

# Or get it via JSON for programmatic use
pnpm cli info --json | jq '.phone_number'
# Output: "+12139230333"
```

**Then use that number in signup**:

```bash
# Get snapshot to find refs
pnpm cli snapshot

# Look for "Continue with phone number" button
pnpm cli tap <ref_from_snapshot>

# Look for EditText input field (ref will vary)
# Enter phone number WITHOUT country code - +1 is auto-selected
pnpm cli set-text <ref_from_snapshot> "<PHONE_NUMBER>"
# OR use type command if field is focused
pnpm cli type "<PHONE_NUMBER>"

# Look for "Next" button
pnpm cli tap <ref_from_snapshot>
```

**Wait for SMS verification code**, then check:

```bash
pnpm cli sms list
# Example: "[rednote] Your verification code is 119103"

# Enter the 6-digit code
pnpm cli type "119103"
```

### 3. Birthday Selection (Date Picker)

**Coordinates** (each value spans ~100px, y range 956-1583):

| Element | X Center | Description |
|---|---|---|
| Year | 284 | Swipe horizontally across year column |
| Month | 534 | Swipe horizontally across month column |
| Day | 790 | Swipe horizontally across day column |

**Swipe Rules**:
- **Start Y: 1113** (center of visible range)
- **Swipe DOWN** (y=1113→1213) to DECREASE value
- **Swipe UP** (y=1113→1013) to INCREASE value
- Use `--pause 300` (300 milliseconds) between swipes to prevent momentum overshoot
- Each ~100px swipe = 1 value change

**Example: Set birthday to 1985/02/18 from 2026/04/24**

```bash
# Year: 2026 → 1985 = decrease 41 years ≈ 4 swipes (100px each)
for i in {1..4}; do
  pnpm cli swipe 284 1113 284 1213 --pause 300
  sleep 0.3
done

# Month: 04 → 02 = decrease 2 months = 2 swipes
for i in {1..2}; do
  pnpm cli swipe 534 1113 534 1213 --pause 300
  sleep 0.3
done

# Day: 24 → 18 = decrease 6 days = 6 swipes
for i in {1..6}; do
  pnpm cli swipe 790 1113 790 1213 --pause 300
  sleep 0.3
done

# Verify with screenshot
pnpm cli screenshot -o /tmp/birthday_check.png
```

**Momentum warning**: Long swipes have momentum and can overshoot. Use short 100px swipes with `--pause 300` (300ms) between each swipe.

### 4. Gender Selection

```bash
# Take snapshot to find gender options
pnpm cli snapshot

# Select desired gender option (ref will vary)
pnpm cli tap <ref_from_snapshot>

# Tap Next button (ref will vary)
pnpm cli tap <ref_from_snapshot>
```

### 5. Interest Selection

```bash
# Take snapshot to find interest options
pnpm cli snapshot

# Select at least 4 interests (refs will vary - find them in snapshot)
# Each interest is a TextView or Button element
pnpm cli tap <ref_from_snapshot>  # Interest 1
pnpm cli tap <ref_from_snapshot>  # Interest 2
pnpm cli tap <ref_from_snapshot>  # Interest 3
pnpm cli tap <ref_from_snapshot>  # Interest 4

# Verify selections - look for [selected] marker in snapshot
pnpm cli snapshot

# Tap "Select 4 interests (4/4)" or "Continue" button
pnpm cli tap <ref_from_snapshot>
```

### 6. Terms of Service

```bash
# Take snapshot to find Agree button
pnpm cli snapshot

# Tap "Agree" button (ref will vary)
pnpm cli tap <ref_from_snapshot>
```

### 7. Language Preference

```bash
# Take snapshot to find language options
pnpm cli snapshot

# Select "In English" button (ref will vary)
pnpm cli tap <ref_from_snapshot>

# OR select original language option
pnpm cli tap <ref_from_snapshot>
```

**Success!** You should now see the home feed.

---

## Home Feed Navigation

### Scrolling

Xiaohongshu uses a complex ViewPager + RecyclerView. Use swipe gestures:

```bash
# Swipe from LEFT COLUMN (x≈270)
pnpm cli swipe 270 1500 270 500 --duration 500

# OR swipe from RIGHT COLUMN (x≈800)
pnpm cli swipe 800 1500 800 500 --duration 500
```

**Important**: Avoid swiping from center (x≈540) - may fail or trigger other gestures.

### Finding Elements

**Important**: Ref IDs change between sessions. NEVER hardcode them.

To find elements, always:
1. Take snapshot: `pnpm cli snapshot`
2. Search for text descriptions (e.g., "Following", "Explore", "technology")
3. Use the ref from the snapshot output

Example patterns you might see (for reference only):
- RecyclerViews: `scrollable="true"`
- Post cards: `long-clickable="true"`
- Buttons: `Button` or `TextView` with button text
- Input fields: `EditText` with placeholder text

---

## Interacting with Posts

### Opening a Post

```bash
# Take snapshot to find post cards
pnpm cli snapshot

# Look for elements with:
# - long-clickable="true"
# - Post title text
# - User name below post
# 
# Tap desired post (ref will vary)
pnpm cli tap <post_ref_from_snapshot>
```

### Liking a Post

**Location**: The Like button is typically a **LinearLayout** immediately AFTER the "Say something..." comment input in the right sidebar.

```bash
# 1. Open post (get ref from snapshot first)
pnpm cli snapshot
pnpm cli tap <post_ref_from_snapshot>
sleep 2

# 2. Scroll within post 2-3 times (user preference)
# Find scrollable element from snapshot
pnpm cli scroll <scrollable_ref_from_snapshot>
sleep 0.5
pnpm cli scroll <scrollable_ref_from_snapshot>
sleep 0.5
pnpm cli scroll <scrollable_ref_from_snapshot>
sleep 1

# 3. Take snapshot to find like button ref
pnpm cli snapshot

# CRITICAL: Look for:
# - FrameLayout with "Say something..." (comment input)
# - LinearLayout AFTER it contains Like button
# - Like button has ImageView (heart icon) + TextView (like count)
# 
# The ref WILL change - always identify from current snapshot!

# 4. Tap like button (ref from snapshot)
pnpm cli tap <like_button_ref_from_snapshot>

# 5. Verify success
pnpm cli snapshot
# Heart should show [selected] and count incremented
```

---

## Search Flow

### Performing a Search

```bash
# Method 1: Tap search icon
pnpm cli snapshot
pnpm cli tap <search_icon_ref_from_snapshot>
sleep 1

# Enter search query
pnpm cli set-text <search_input_ref_from_snapshot> "technology"
sleep 1

# Execute search
pnpm cli key enter
# OR tap search button (ref will vary)
pnpm cli tap <search_button_ref_from_snapshot>

# Method 2: Tap search bar directly if focused
pnpm cli set-text <search_input_ref_from_snapshot> "technology"
pnpm cli key enter
```

### Searching and Liking Multiple Posts

**Batch pattern for first N posts**:

```bash
# 1. Search
pnpm cli tap <search_icon_ref_from_snapshot>
pnpm cli type "technology"
sleep 1
pnpm cli key enter
sleep 3

# 2. Like first three posts (or any N posts)
# IMPORTANT: Always get fresh refs before each action!
for i in 1 2 3; do
  # Get snapshot to find next post card
  pnpm cli snapshot
  pnpm cli tap <post_card_ref_from_snapshot>
  sleep 2
  
  # Scroll within post
  pnpm cli scroll <scrollable_ref_from_snapshot>
  sleep 0.5
  pnpm cli scroll <scrollable_ref_from_snapshot>
  sleep 1
  
  # CRITICAL: Get fresh snapshot for like button ref
  pnpm cli snapshot
  
  # Tap like button (ref from snapshot)
  pnpm cli tap <like_button_ref_from_snapshot>
  
  # Go back
  pnpm cli key back
  sleep 1
done
```

---

## Navigation Commands

### Go Back

```bash
# Use back key
pnpm cli key back

# OR tap back/return button (ref=e550)
pnpm cli tap e550
```

### Android Home

```bash
pnpm cli key home
```

### Recent Apps

```bash
pnpm cli key recents
```

---

## Screen State Management

```bash
# Check screen state BEFORE interacting
pnpm cli info

# screen_state values: unlocked, locked, asleep, dozing, dreaming, unknown

# Wake phone if asleep
pnpm cli key wake

# Swipe to dismiss lock screen if needed
pnpm cli swipe 540 1500 540 500
```

---

## Finding Navigation Elements

**CRITICAL**: Reference IDs are completely undeterministic. They change between:
- App launches
- Screen navigations
- Session restarts
- Even within the same screen if elements are refreshed

**Never assume any ref will be valid** - always verify with snapshot.

**How to find navigation elements**:

```bash
# Take snapshot
pnpm cli snapshot

# Look for elements by their TEXT CONTENT:
# - "Following", "Explore", "Nearby" for top tabs
# - "Home", "Market", "Messages", "Me" for bottom nav
# - Magnifying glass or "Search" for search button
# - Arrow "Back" for back button

# Example: Find "Home" button
# In snapshot output, look for:
#   TextView "Home" [ref=e234]
# Then use: pnpm cli tap e234
```

---

## Complete Automation Script (Template)

```bash
#!/bin/bash
# CRITICAL: Always get refs from snapshots before each action!
# This is a TEMPLATE - replace all <ref_from_snapshot> placeholders

cd /Users/nick/code/otacon

# Get phone number from device info
PHONE_NUMBER=$(pnpm cli info --json | jq -r '.phone_number' | tr -d '+')

echo "Using phone number: $PHONE_NUMBER"

# Install app
pnpm cli app install /path/to/xhs-9.26.0.apkm
sleep 3

# Launch app
pnpm cli app launch com.xingin.xhs

# Accept Privacy & Terms
sleep 2
pnpm cli snapshot  # CRITICAL: GET REF HERE
pnpm cli tap <agree_ref_from_snapshot>
sleep 2

# Phone signup
pnpm cli snapshot  # GET REF HERE
pnpm cli tap <phone_signup_ref_from_snapshot>
sleep 1

pnpm cli set-text <phone_input_ref_from_snapshot> "$PHONE_NUMBER"
sleep 1

pnpm cli snapshot  # GET REF HERE
pnpm cli tap <next_ref_from_snapshot>
sleep 3

# Get SMS code and enter it
SMS_CODE=$(pnpm cli sms list | grep "rednote" | grep -oP '\d{6}' | head -1)
echo "SMS code: $SMS_CODE"
pnpm cli type "$SMS_CODE"
sleep 2

# Birthday selection (example: 1985/02/18)
# Year: swipe down 4 times (100px each)
for i in {1..4}; do pnpm cli swipe 284 1113 284 1213 --pause 300; sleep 0.3; done

# Month: swipe down 2 times
for i in {1..2}; do pnpm cli swipe 534 1113 534 1213 --pause 300; sleep 0.3; done

# Day: swipe down 6 times
for i in {1..6}; do pnpm cli swipe 790 1113 790 1213 --pause 300; sleep 0.3; done

sleep 2

# Continue (GET REF FROM SNAPSHOT)
pnpm cli snapshot
pnpm cli tap <continue_ref_from_snapshot>
sleep 2

# Gender selection
pnpm cli snapshot
pnpm cli tap <gender_option_ref_from_snapshot>
sleep 1

pnpm cli snapshot
pnpm cli tap <next_ref_from_snapshot>
sleep 2

# Interest selection (at least 4)
# GET REF FOR EACH INTEREST FROM SNAPSHOT!
pnpm cli snapshot
pnpm cli tap <interest_1_ref_from_snapshot>
pnpm cli tap <interest_2_ref_from_snapshot>
pnpm cli tap <interest_3_ref_from_snapshot>
pnpm cli tap <interest_4_ref_from_snapshot>
sleep 1

pnpm cli snapshot
pnpm cli tap <continue_ref_from_snapshot>
sleep 3

# Terms of Service
pnpm cli snapshot
pnpm cli tap <agree_ref_from_snapshot>
sleep 2

# Language preference
pnpm cli snapshot
pnpm cli tap <language_option_ref_from_snapshot>
sleep 3

echo "Xiaohongshu setup complete!"
```

---

## Tips for AI Agents

1. **CRITICAL: Always snapshot before tapping** - refs are volatile and change after EVERY navigation. Never assume refs are valid.

2. **NEVER hardcode refs** - they are session-specific and expire immediately. Always get from current snapshot.

3. **Use screenshot + snapshot together** - screenshots help visualize what you're targeting; snapshots provide ref IDs.

4. **Momentum swipes overshoot** - use 100px swipes with `--pause 300` (milliseconds!) for date pickers.

5. **Like button pattern** - Look for LinearLayout immediately AFTER "Say something..." FrameLayout in right sidebar.

6. **Phone number entry** - Enter WITHOUT country code; +1 auto-selected for US numbers.

7. **Scroll before liking** - User preference: ~3 screen scrolls within post before liking.

8. **Column swipes** - Use x≈270 (left) or x≈800 (right) for feed scrolling, NOT center (x≈540).

9. **Batch operations** - Always snapshot between EACH action in loops. Don't reuse refs across iterations.

10. **Identify by text content** - When possible, search snapshot output for unique text rather than relying on ref patterns.

11. **Verify refs before each action** - Navigation invalidates ALL refs. Take snapshot IMMEDIATELY before each tap.

---

## Troubleshooting

### Like Button Not Found

- Ensure you're in post detail view (not home feed)
- Scroll within post 2-3 times first
- Take fresh snapshot immediately before tapping
- Look for LinearLayout AFTER "Say something..." FrameLayout
- Like button = inner LinearLayout with ImageView (heart) + TextView (count)

### Swipe Not Moving Feed

- Swipe from column edge (x≈270 or x≈800), not center
- Use distance ≥1000px vertical travel
- Add `--duration 500` for momentum control
- Try `scroll` command as alternative

### Date Picker Overshoot

- Use short 100px swipes only
- Add `--pause 300` (300 milliseconds) between swipes
- Count exact values needed (not estimate)
- Verify with screenshot after each batch

### Ref IDs Don't Work

- Refs are volatile - snapshot IMMEDIATELY before tap
- Navigation invalidates ALL refs - always get fresh snapshot
- Use `--json` snapshot for more stable identification
- Match on unique text content when possible

### Session Continuity

```bash
# Check current app state
pnpm cli app running

# If wrong screen, go back
pnpm cli key back

# Verify with screenshot
pnpm cli screenshot -o /tmp/check.png
```

---

## Debugging Commands

```bash
# Record session
pnpm cli record start -d 120 -o /tmp/xhs_session.mp4

# Monitor state
pnpm cli info

# Full accessibility tree
pnpm cli snapshot --json > /tmp/xhs_tree.json

# Check running apps
pnpm cli app running

# Take screenshot
pnpm cli screenshot -o /tmp/current.png
```

---

## Coordinate Reference Summary

### Date Picker (All Y ranges: 956-1583)

| Element | X | Per Value | Swipe Down (Decrease) | Swipe Up (Increase) |
|---|---|---|---|---|
| Year | 284 | 100px | 284 1113 → 284 1213 | 284 1113 → 284 1013 |
| Month | 534 | 100px | 534 1113 → 534 1213 | 534 1113 → 534 1013 |
| Day | 790 | 100px | 790 1113 → 790 1213 | 790 1113 → 790 1013 |

### Feed Scrolling

| Direction | Coordinates | Notes |
|---|---|---|
| Scroll Down | 270 1500 → 270 500 | Left column |
| Scroll Down | 800 1500 → 800 500 | Right column |
| Scroll Up | 270 500 → 270 1500 | Left column |
| Scroll Up | 800 500 → 800 1500 | Right column |

**Always use `--duration 500` for reliable scrolling**

---

**Skill version**: 2.0  
**Last updated**: Based on session discovering Xiaohongshu automation from scratch
