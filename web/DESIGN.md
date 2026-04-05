# Design System: XRPL Lending Protocol
## Fusion: Linear (structure + typography) × Stripe (fintech depth + shadows)

## 1. Visual Theme & Atmosphere

Dark-mode-native. Near-black canvas (`#08090a`) where content emerges from darkness. 
Linear's extreme precision (achromatic scale, semi-transparent borders) combined with 
Stripe's fintech warmth (blue-tinted multi-layer shadows, confident indigo-violet CTA).

The result: a premium data-dense lending dashboard. Think "Linear built a DeFi app". 
Darkness as the native medium. Information density managed through luminance gradations.
Blue-tinted shadows add depth that feels financial-grade, not cold.

**Key Characteristics:**
- Dark-mode-native: `#08090a` background, `#0f1011` panel, `#191a1b` elevated surfaces
- Inter Variable with `"cv01", "ss03"` on all UI text — Linear's geometric identity
- Signature weight 510 for UI elements, 400 for reading text
- Aggressive negative letter-spacing at display sizes (−1.056px at 48px)
- Primary accent: indigo-violet `#5e6ad2` (CTA) / `#7170ff` (interactive)
- Blue-tinted shadows à la Stripe: `rgba(50,50,93,0.25)` layered with `rgba(0,0,0,0.1)`
- Semi-transparent white borders: `rgba(255,255,255,0.08)` — structure without noise
- `"tnum"` OpenType feature for all financial numbers (APY, amounts, HF)

## 2. Color Palette & Roles

### Backgrounds (Linear scale)
- **Canvas** (`#08090a`): Deepest background, page canvas
- **Panel** (`#0f1011`): Sidebar, topbar, panel backgrounds
- **Surface** (`#191a1b`): Cards, dropdowns, elevated containers
- **Hover Surface** (`#28282c`): Hover states on cards and rows

### Text (Linear achromatic)
- **Primary** (`#f7f8f8`): Headings, key values — near-white, not pure white
- **Secondary** (`#d0d6e0`): Body text, labels, descriptions
- **Muted** (`#8a8f98`): Metadata, APY labels, secondary stats
- **Subtle** (`#62666d`): Timestamps, disabled states, fine print

### Brand Accent (Linear indigo meets Stripe purple)
- **Primary CTA** (`#5e6ad2`): Primary buttons, brand elements
- **Interactive** (`#7170ff`): Links, active states, hover accents
- **Hover** (`#828fff`): Accent hover state
- **Muted Accent** (`#7a7fad`): Subdued accent for secondary use

### Status
- **Success** (`#10b981`): Positive HF, supply APY indicator, success toasts
- **Warning** (`#f59e0b`): HF approaching danger zone (HF < 1.5)
- **Danger** (`#ef4444`): HF < 1.0, liquidatable positions, error states
- **Info** (`#3b82f6`): Borrow APY indicator, informational elements

### Borders (Linear semi-transparent)
- **Border Default** (`rgba(255,255,255,0.08)`): Cards, inputs, separators
- **Border Subtle** (`rgba(255,255,255,0.05)`): Very subtle divisions
- **Border Solid** (`#23252a`): Prominent separations when opacity won't work

### Shadows (Stripe blue-tinted on Linear surfaces)
- **Card Shadow**: `rgba(50,50,93,0.25) 0px 20px 40px -20px, rgba(0,0,0,0.15) 0px 10px 20px -10px`
- **Elevated Shadow**: `rgba(50,50,93,0.3) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px`
- **Subtle Shadow**: `rgba(0,0,0,0.2) 0px 4px 8px`

## 3. Typography Rules

### Font
- **Primary**: `Inter Variable` — fallback `system-ui, -apple-system`
- **Monospace**: `ui-monospace, SF Mono, Menlo` — for addresses, hashes
- **OpenType**: `"cv01", "ss03"` on all Inter; `"tnum"` for all financial numbers

### Scale

| Role | Size | Weight | Letter Spacing | Use |
|------|------|--------|----------------|-----|
| Display | 32px | 510 | −0.704px | Page titles |
| Heading | 20px | 590 | −0.24px | Card headers, section titles |
| Subheading | 16px | 510 | normal | Table headers, labels |
| Body | 15px | 400 | −0.165px | Descriptions, body text |
| Value Large | 24px | 590 | −0.288px | Net worth, key metric values |
| Value | 18px | 510 | −0.165px | APY, amounts, HF |
| Value Mono | 14px | 400 | normal | Addresses, tx hashes (`tnum`) |
| Caption | 12px | 510 | normal | Tags, badges, status labels |
| Tiny | 11px | 510 | normal | Fine print, metadata |

### Financial Numbers Rule
Any APY %, dollar amount, token amount, health factor, or utilization % 
**must** use `font-feature-settings: "tnum"` for aligned tabular display.

## 4. Component Stylings

### Primary Button (CTA)
- Background: `#5e6ad2`
- Text: `#f7f8f8`, weight 510, 15px
- Padding: 8px 16px, radius: 6px
- Hover: `#7170ff` background
- Use: Supply, Borrow, Connect Wallet

### Ghost Button
- Background: `rgba(255,255,255,0.03)`
- Text: `#d0d6e0`, weight 510, 15px
- Padding: 8px 16px, radius: 6px
- Border: `1px solid rgba(255,255,255,0.08)`
- Hover: background → `rgba(255,255,255,0.05)`
- Use: Withdraw, Cancel, secondary actions

### Metric Card
- Background: `rgba(255,255,255,0.02)`
- Border: `1px solid rgba(255,255,255,0.08)`, radius: 8px
- Shadow: card shadow (Stripe blue-tinted)
- Padding: 20px 24px
- Title: 12px weight 510 muted `#8a8f98`
- Value: 24px weight 590 primary `#f7f8f8` with `"tnum"`

### Data Table Row
- Default bg: transparent
- Hover bg: `rgba(255,255,255,0.025)`
- Border-bottom: `1px solid rgba(255,255,255,0.05)`
- Cell text: 14px weight 400 secondary `#d0d6e0`
- Numeric cells: `"tnum"` feature

### Health Factor Gauge
- Track: `rgba(255,255,255,0.08)` background bar
- Fill colors:
  - HF ≥ 2.0: `#10b981` (safe)
  - 1.2 ≤ HF < 2.0: `#f59e0b` (caution)
  - HF < 1.2: `#ef4444` (danger / liquidatable)
- Display value: 24px weight 590 colored by status, `"tnum"`

### Input Fields
- Background: `rgba(255,255,255,0.02)`
- Border: `1px solid rgba(255,255,255,0.08)`, radius: 6px
- Text: `#f7f8f8`, placeholder: `#62666d`
- Focus border: `#5e6ad2` (brand indigo)
- Padding: 10px 14px

### Dialog / Modal
- Background: `#0f1011`
- Border: `1px solid rgba(255,255,255,0.08)`, radius: 12px
- Shadow: elevated shadow (deep blue-tinted)
- Header: 20px weight 590 `#f7f8f8`
- Overlay backdrop: `rgba(0,0,0,0.85)`

### Asset Badge (pill)
- Background: `rgba(255,255,255,0.05)`
- Border: `1px solid rgba(255,255,255,0.08)`, radius: 9999px
- Text: 12px weight 510 `#d0d6e0`
- Token icon: 16px circle with 2px radius

### Success Toast
- Background: `#0f1011`
- Border-left: 3px solid `#10b981`
- Text: 14px `#d0d6e0`

### Error Toast
- Background: `#0f1011`
- Border-left: 3px solid `#ef4444`

## 5. Layout Principles

- Base unit: 8px — all spacing multiples of 4px/8px
- Max content width: 1200px, centered
- Topbar height: 64px, sticky, `#0f1011` background
- Main content: `calc(100vh - 64px)`, padding 24px horizontal
- Dashboard: grid 2/3 left + 1/3 right on desktop, stacked on mobile
- Markets table: full width, 5 columns
- Sidebar (if present): 240px fixed left

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Canvas | `#08090a` | Page background |
| Panel | `#0f1011` | Topbar, panels |
| Surface | `rgba(255,255,255,0.02)` bg + `rgba(255,255,255,0.08)` border | Cards |
| Hover | `rgba(255,255,255,0.025)` | Table row hover |
| Floating | Surface + Stripe card shadow | Dropdowns, dialogs |
| Dialog | `#0f1011` + elevated shadow | Modals |

## 7. Do's and Don'ts

### Do
- Always use `font-feature-settings: "tnum"` for any number the user needs to compare
- Use `rgba(255,255,255,0.08)` borders — never solid opaque borders on dark surfaces
- Color HF by health: green/amber/red for ≥2 / 1–2 / <1
- Use `#5e6ad2` as the only chromatic CTA color
- Apply blue-tinted shadows for any floating element (Stripe-style depth)
- Show loading skeletons, never blank white flash
- Keep Inter weight ≤590 — no bold/700

### Don't
- Don't use white backgrounds anywhere in the dark theme
- Don't use warm orange/yellow for interactive elements — only for warning status
- Don't skip `"tnum"` on financial data
- Don't introduce more than 2 chromatic colors in any single component
- Don't use pure `#000000` or `#ffffff` as text colors

## 8. Responsive Behavior

- Mobile (<640px): stack all grids, full-width cards, condensed topbar
- Tablet (640–1024px): 2-column dashboard, collapsible sidebar
- Desktop (≥1024px): full layout with 3-column market table
- Touch targets: minimum 44px height for all interactive elements
- HF gauge: maintains full width at all breakpoints

## 9. Agent Prompt Guide

### Quick Color Reference
```
Canvas:       #08090a
Panel:        #0f1011  
Surface:      rgba(255,255,255,0.02) + rgba(255,255,255,0.08) border
Primary text: #f7f8f8
Secondary:    #d0d6e0
Muted:        #8a8f98
CTA:          #5e6ad2 → hover #7170ff
Success:      #10b981
Warning:      #f59e0b
Danger:       #ef4444
Border:       rgba(255,255,255,0.08)
```

### Financial Number Pattern
```css
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum";
```

### Elevation Pattern (cards/dialogs)
```css
background: rgba(255,255,255,0.02);
border: 1px solid rgba(255,255,255,0.08);
box-shadow: rgba(50,50,93,0.25) 0px 20px 40px -20px, rgba(0,0,0,0.15) 0px 10px 20px -10px;
```
