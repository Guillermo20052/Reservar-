// Feature flags. Flip a flag to true to turn the feature's UI back on.
//
// modalities: Nair learning modalities (picker on class cards, missing-
//   modalities banner and confirm prompt in "Reservar mi espacio", plus the
//   "Uso de espacios" / "Mis modalidades" tabs). Hidden until January. The
//   database side (modalities, class_modalities, set_class_modalities) stays
//   in place either way.
export const FEATURES = {
  modalities: true,
};
