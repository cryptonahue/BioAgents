/**
 * Icon component using Phosphor icons
 * https://phosphoricons.com/
 *
 * Phosphor differs from Lucide in three ways that matter here:
 *
 *  - Phosphor icons are FILL-based on a 256x256 grid; Lucide icons are
 *    STROKE-based on a 24x24 grid. Stroke thickness is therefore not a number
 *    you pass in — it is selected with the `weight` prop. The old `strokeWidth`
 *    prop is gone (nothing passed it) and `weight` replaces it. "regular" is the
 *    closest match to the Lucide default this codebase was rendering.
 *  - The `size` prop still sets width/height in pixels, so every existing
 *    `<Icon size={n} />` call renders at exactly the same box as before despite
 *    the different internal viewBox.
 *  - Names differ. The map below is the deliberate Lucide -> Phosphor mapping;
 *    it is not a mechanical rename.
 *
 * Phosphor is a React library. It reaches this Preact app through the
 * `react-to-preact-alias` plugin in client/build.ts. Its React surface is
 * small and fully supported by preact/compat: createContext, useContext,
 * forwardRef and createElement, with no useId or useSyncExternalStore.
 *
 * Importing from the package barrel is safe here despite Phosphor's reputation
 * for dragging in all ~1500 icons: Bun tree-shakes it. A barrel import and the
 * equivalent per-icon `dist/csr/*` imports were measured and produced a
 * byte-identical bundle, so the barrel is used for readability. Only the icons
 * referenced below are bundled.
 */

import {
  ArrowsClockwise,
  ArrowSquareOut,
  BookOpen,
  Brain,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChartBar,
  Chat,
  Check,
  CheckCircle,
  Circle,
  ClipboardText,
  Code,
  Copy,
  DotsThree,
  Download,
  Dna,
  File,
  FileCode,
  Flask,
  Folder,
  Gear,
  GitMerge,
  Globe,
  GraduationCap,
  Image,
  Info,
  Lightbulb,
  Lightning,
  List,
  MagnifyingGlass,
  MapPin,
  Microphone,
  Microscope,
  Moon,
  PaperPlaneTilt,
  Paperclip,
  Pill,
  Play,
  Plus,
  Prohibit,
  Pulse,
  Robot,
  ShareNetwork,
  SignOut,
  Sparkle,
  Spinner,
  SquaresFour,
  Sun,
  Syringe,
  Target,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash,
  Upload,
  User,
  Warning,
  WarningCircle,
  X,
  XCircle,
  type IconWeight,
} from "@phosphor-icons/react";

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  weight?: IconWeight;
}

/**
 * Lucide -> Phosphor mapping.
 *
 * Most entries are a straight rename (Search -> MagnifyingGlass,
 * Settings -> Gear, Trash2 -> Trash, Zap -> Lightning, ...). The ones worth
 * calling out:
 *
 *   activity     Lucide Activity is the ECG/heartbeat line. Phosphor has no
 *                icon called "Activity"; the same glyph is "Pulse".
 *   brainCircuit Phosphor has no brain-with-circuit-traces icon. "Brain" keeps
 *                the meaning; "Circuitry" would keep the traces but lose the
 *                brain, and the brain is the point.
 *   flask        Lucide FlaskConical is an Erlenmeyer flask, which is exactly
 *                what Phosphor's "Flask" draws.
 *   menu         MoreHorizontal is a horizontal ellipsis -> "DotsThree".
 *   messageSquare Phosphor "Chat" is the rounded-square bubble. "ChatCircle"
 *                would change the silhouette.
 *   share        Lucide Share2 is the three-node network -> "ShareNetwork",
 *                not Phosphor's "Share" (which is an arrow out of a box).
 *   send         Lucide Send is a tilted paper plane -> "PaperPlaneTilt".
 *   upload       Phosphor "Upload" is the tray-with-arrow, matching Lucide.
 *                "UploadSimple" is a bare arrow and would not match.
 */
const iconMap: Record<string, any> = {
  user: User,
  bot: Robot,
  send: PaperPlaneTilt,
  attach: Paperclip,
  copy: Copy,
  check: Check,
  close: X,
  trash: Trash,
  plus: Plus,
  search: MagnifyingGlass,
  logout: SignOut,
  chevronLeft: CaretLeft,
  chevronRight: CaretRight,
  chevronDown: CaretDown,
  // `chevronUp` was ALREADY being rendered by the research panel's
  // "Show less" toggle and was never in this map: `Icon` fell through to its
  // `return null`, so that button showed a bare label and console.warn'd on every
  // render. Registering it is the fix.
  chevronUp: CaretUp,
  file: File,
  fileCode: FileCode,
  menu: DotsThree,
  mic: Microphone,
  image: Image,
  globe: Globe,
  /* The arrow-out-of-a-box glyph, and the ONE place Phosphor's own "Share" is the
     right icon rather than "ShareNetwork" — but it is not a share affordance, so it
     is named for what it means: this link leaves the app. Every external link in the
     client wears it, which is the WCAG 3.2.5 warning that a new tab is about to
     open. */
  externalLink: ArrowSquareOut,
  lightbulb: Lightbulb,
  thumbsUp: ThumbsUp,
  thumbsDown: ThumbsDown,
  share: ShareNetwork,
  refresh: ArrowsClockwise,
  dna: Dna,
  microscope: Microscope,
  activity: Pulse,
  syringe: Syringe,
  pill: Pill,
  flask: Flask,
  target: Target,
  bookOpen: BookOpen,
  graduationCap: GraduationCap,
  messageSquare: Chat,
  brainCircuit: Brain,
  settings: Gear,
  barChart: ChartBar,
  gitMerge: GitMerge,
  zap: Lightning,
  download: Download,
  terminal: Terminal,
  alertTriangle: Warning,
  alertCircle: WarningCircle,
  code: Code,
  play: Play,
  sparkles: Sparkle,
  folder: Folder,
  upload: Upload,
  mapPin: MapPin,
  list: List,
  grid: SquaresFour,
  // Theme toggle. No Lucide ancestor — these two are new with the light/dark
  // switch, so the Phosphor names carry straight through.
  sun: Sun,
  moon: Moon,

  /*
   * EMOJI REPLACEMENTS.
   *
   * These have no Lucide ancestor either: they replace emoji that were being
   * rendered as UI (task-type chips, status glyphs, section headers, toast
   * icons). The mapping is by MEANING, not by shape — an emoji is a picture, an
   * icon is a symbol, and the ones worth calling out are:
   *
   *   clipboard    📋 is a clipboard, and Phosphor's "List" (already mapped as
   *                `list`) is a bare bulleted list. PLANNING and the activity log
   *                mean "the checklist of work", so this is `ClipboardText`, not
   *                `List`.
   *   checkCircle  ✅ is a check INSIDE a filled disc. Plain `Check` (mapped as
   *                `check`) is the bare tick and is the right glyph for a
   *                per-row done marker; the disc is what a SECTION header and a
   *                success toast want, so both spellings exist and are used
   *                deliberately.
   *   xCircle      ✕ vs ❌. Same split as above: `close` is the bare X used for
   *                dismiss affordances, `xCircle` is the status disc.
   *   circle       ○ — the "no matches" glyph in the evidence panel. An absence,
   *                not a failure, so it is an empty ring rather than a hue.
   *   prohibit     ⊘ — the corpus dashboard's "skipped" state. Phosphor's
   *                "Prohibit" is the circle-with-a-slash; "ProhibitInset" puts
   *                the slash inside the ring and reads as a different symbol.
   *   spinner      ⏳ meant "this step is running". An hourglass is a WAIT; the
   *                app's other in-progress affordance is a spinner, so this
   *                matches the app rather than the emoji.
   *   info         ℹ — the toast's info type.
   */
  clipboard: ClipboardText,
  checkCircle: CheckCircle,
  xCircle: XCircle,
  circle: Circle,
  prohibit: Prohibit,
  spinner: Spinner,
  info: Info,
};

/**
 * Icon component wrapper for Phosphor icons
 * Provides consistent sizing and styling
 */
export function Icon({
  name,
  size = 16,
  className = "",
  weight = "regular",
}: IconProps) {
  const IconComponent = iconMap[name];

  if (!IconComponent) {
    console.warn(`Icon "${name}" not found`);
    return null;
  }

  return <IconComponent size={size} weight={weight} className={className} />;
}
