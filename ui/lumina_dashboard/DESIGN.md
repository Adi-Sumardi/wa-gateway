---
name: Lumina Dashboard
colors:
  surface: '#f7f9fc'
  surface-dim: '#d8dadd'
  surface-bright: '#f7f9fc'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f7'
  surface-container: '#eceef1'
  surface-container-high: '#e6e8eb'
  surface-container-highest: '#e0e3e6'
  on-surface: '#191c1e'
  on-surface-variant: '#3c4a3d'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f4'
  outline: '#6c7b6b'
  outline-variant: '#bbcbb9'
  surface-tint: '#006d2f'
  primary: '#006d2f'
  on-primary: '#ffffff'
  primary-container: '#25d366'
  on-primary-container: '#005523'
  inverse-primary: '#3de273'
  secondary: '#1c695f'
  on-secondary: '#ffffff'
  secondary-container: '#a5ede0'
  on-secondary-container: '#226e63'
  tertiary: '#006b5f'
  on-tertiary: '#ffffff'
  tertiary-container: '#63c9b9'
  on-tertiary-container: '#005249'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#66ff8e'
  primary-fixed-dim: '#3de273'
  on-primary-fixed: '#002109'
  on-primary-fixed-variant: '#005322'
  secondary-fixed: '#a8f0e3'
  secondary-fixed-dim: '#8cd4c7'
  on-secondary-fixed: '#00201c'
  on-secondary-fixed-variant: '#005047'
  tertiary-fixed: '#8ff4e3'
  tertiary-fixed-dim: '#72d8c8'
  on-tertiary-fixed: '#00201c'
  on-tertiary-fixed-variant: '#005047'
  background: '#f7f9fc'
  on-background: '#191c1e'
  surface-variant: '#e0e3e6'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 60px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  code-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 40px
  xl: 64px
  container-max: 1440px
  sidebar-width: 280px
---

## Brand & Style
The brand personality for the design system is professional, efficient, and reliable, catering specifically to high-volume communication management. The target audience includes developers, marketing teams, and customer success managers who require a high-density information environment that remains approachable.

The design style follows a **Corporate / Modern** aesthetic with a strong emphasis on **Minimalism** to ensure data visualization remains the primary focus. It utilizes a "UI/UX Pro Max" philosophy: leveraging ample whitespace, subtle depth through layered surfaces, and high-quality iconography to reduce cognitive load. The UI should evoke a sense of "active calm"—highly functional and technical, yet visually soft and inviting through large corner radii.

## Colors
The color palette is derived from the core identity of modern messaging, optimized for professional dashboard environments. 

- **Primary (#25D366):** Used for primary actions, success states, and key metrics. It provides the "active" energy of the platform.
- **Secondary (#075E54):** Reserved for sidebar backgrounds, navigation headers, and deep-contrast elements to ground the UI.
- **Backgrounds:** A clean `#FFFFFF` is used for cards and workspace areas, while `#F0F2F5` provides a soft contrast for the global background and page gutters.
- **Typography:** Deep charcoal (#111B21) ensures high readability for data, while muted slate (#667781) is used for secondary metadata and labels.

## Typography
This design system uses a dual-font strategy to balance character with utility. 

**Plus Jakarta Sans** is used for headlines and titles. Its slightly rounded, open apertures provide a modern and welcoming feel that aligns with the "large radius" shape language of the system.

**Inter** is utilized for body text, labels, and data tables. It is chosen for its exceptional legibility at small sizes and its neutral, systematic appearance, which is essential for a gateway dashboard containing logs and technical configurations.

For mobile responsiveness, large headlines (32px+) scale down to 24px to ensure they don't break containers while maintaining visual hierarchy.

## Layout & Spacing
The layout follows a **Fluid Grid** model with a sidebar navigation structure. 

- **Desktop:** A fixed-width sidebar (280px) on the left, with a fluid content area on the right. Content is constrained to a max-width of 1440px to prevent excessive line lengths on ultra-wide monitors.
- **Grid:** A 12-column system is used within the content area. For dashboard widgets (cards), use 3, 4, or 6-column spans.
- **Rhythm:** An 8px base unit (linear scale) governs all padding and margins. Use 24px (md) for the primary gutter between dashboard cards and 12px (sm) for internal card padding.
- **Mobile:** The sidebar collapses into a bottom navigation bar or a hamburger menu. Margins reduce to 16px to maximize screen real estate.

## Elevation & Depth
Depth in the design system is achieved through **Tonal Layers** combined with **Ambient Shadows**. This approach creates a sense of "organized physical layers" without looking dated.

- **Level 0 (Surface):** The global background (`#F0F2F5`).
- **Level 1 (Cards/Containers):** Pure white (`#FFFFFF`) with a subtle 1px border (`#D1D7DB`) and a very soft, diffused shadow (0px 4px 20px rgba(0, 0, 0, 0.04)).
- **Level 2 (Popovers/Modals):** Floating elements use a more pronounced shadow (0px 12px 32px rgba(0, 0, 0, 0.1)) to indicate high priority and interaction distance from the base dashboard.
- **Interactive States:** Buttons and clickable cards should "lift" slightly on hover using a tighter, slightly darker shadow to provide tactile feedback.

## Shapes
The shape language is defined as **Rounded**, leaning towards a high-end consumer-tech aesthetic. 

Standard components like input fields and small buttons use a 0.5rem (8px) radius. Larger containers, such as dashboard cards and main content modules, use a `rounded-lg` (16px) or `rounded-xl` (24px) radius. This creates a friendly, modern silhouette that differentiates the product from strictly "utility-first" developer tools.

## Components

- **Buttons:** Primary buttons use a solid WhatsApp Green background with white text. They should have high horizontal padding (24px) and bold weights. Secondary buttons use a ghost style with a subtle grey border.
- **Cards:** The central building block of the dashboard. Every card must have a consistent 24px internal padding. Title areas within cards should be separated by a light 1px horizontal rule or distinct background tint.
- **Inputs:** Text fields use a light grey stroke that turns into the Primary Green on focus. Labels should be placed above the field in `label-md` weight.
- **Status Chips:** Use high-contrast "Pill" shapes for status (e.g., "Connected", "Pending"). Use light-tinted backgrounds of the status color with high-saturation text (e.g., Light green background with dark green text for "Active").
- **Data Tables:** High-density rows with `body-md` typography. Use alternating row colors or very thin separators. The header row should be slightly tinted (#F0F2F5) to anchor the data.
- **Iconography:** Use a consistent 2px stroke weight. Icons should be "Linear" or "Two-tone" using the secondary green color to add a premium feel to the navigation.