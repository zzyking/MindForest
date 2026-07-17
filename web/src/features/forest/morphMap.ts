/**
 * Pure morph helpers re-exported for forest modules that shouldn't
 * import the zustand store (keeps sim/draw free of React).
 */

export {
  MU_COLD,
  cameraRatioForMu,
  edgeStyleForMaterial,
  mapMorph,
  sizeScaleForMaterial,
  typeSoftness,
} from "@/stores/morph";

export {
  chargeScale,
  layoutBeta,
  scopeBand,
  treeAnchorStrength,
  treeSnapBlend,
  type ScopeBand,
} from "./layoutContinuum";
