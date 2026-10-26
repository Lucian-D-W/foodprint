import { invoke } from "@tauri-apps/api/core";

export type VisitStatus = "unknown" | "want_to_go" | "visited" | "frequent";
export type AffectionStatus = "neutral" | "like" | "favorite" | "avoid";

export type MapRestaurant = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  cuisineKey: string;
  iconKey: string;
  overallRating: number | null;
  visitStatus: VisitStatus;
  affectionStatus: AffectionStatus;
  isBookmarked: boolean;
  logCount: number;
  mapIconScale: number;
  positionLocked: boolean;
};

export type Tag = { id: string; name: string };
export type Restaurant = MapRestaurant & {
  phone?: string | null;
  openingHoursText?: string | null;
  addressNote?: string | null;
  tags: Tag[];
};

export type CuisineIcon = { key: string; src: string };
export type Cuisine = { key: string; label: string; icons: CuisineIcon[] };
export type RestaurantManifest = { cuisines: Cuisine[]; foodIconBaseUrl: string };

export type MealType = "breakfast" | "lunch" | "dinner" | "late_night" | "other";
export type DiningMode = "dine_in" | "delivery" | "takeaway" | "other";
export type FoodLog = {
  id: string;
  restaurantId: string;
  occurredAtMs: number;
  tzOffsetMinutes: number;
  mealType: MealType | null;
  diningMode: DiningMode | null;
  title: string | null;
  note: string;
  rating: number | null;
};
export type FoodLogPage = { items: FoodLog[]; nextCursor: string | null };
export type FoodLogInput = {
  restaurantId: string;
  occurredAtMs: number;
  tzOffsetMinutes: number;
  mealType?: MealType | null;
  diningMode?: DiningMode | null;
  title?: string | null;
  note: string;
  rating?: number | null;
};

export const MEDIA_CATEGORIES = ["food", "menu", "exterior", "interior", "checkin", "other"] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export type Media = {
  id: string;
  restaurantId: string;
  foodLogId: string | null;
  category: MediaCategory;
  originalName: string;
  mimeType: string;
  originalRelPath: string;
  previewRelPath: string;
  thumbnailRelPath: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  capturedAtMs: number | null;
  caption: string | null;
  createdAtMs: number;
  restaurant?: { id: string; name: string };
  foodLog?: { id: string; title: string | null; occurredAtMs: number } | null;
};
export type MediaPage = { items: Media[]; nextCursor: string | null };
export type MediaImportItem = {
  sourcePath: string;
  media: Media | null;
  error: string | null;
  code?: "DUPLICATE_MEDIA";
  existingMedia?: Media | null;
};
export type MediaImportResult = { results: MediaImportItem[] };

export const TRASH_ENTITY_TYPES = ["restaurant", "foodLog", "media"] as const;
export type TrashEntityType = (typeof TRASH_ENTITY_TYPES)[number];
export type TrashItem = {
  entity: TrashEntityType;
  id: string;
  title: string;
  deletedAtMs: number;
  restaurantId?: string | null;
  logCount?: number | null;
  mediaCount?: number | null;
};
export type TrashSnapshot = { items: TrashItem[]; cleanupPending: number };
export type BackupResult = {
  path: string;
  restaurants: number;
  foodLogs: number;
  media: number;
  bytes: number;
  mapReinstallHint: boolean;
};
export type RestorePreview = BackupResult;

export const restaurantApi = {
  listMap: () => invoke<MapRestaurant[]>("list_restaurant_map"),
  get: (id: string) => invoke<Restaurant | null>("get_restaurant", { input: { id } }),
  manifest: () => invoke<RestaurantManifest>("restaurant_manifest"),
  create: (input: {
    name: string;
    cuisineKey: string;
    iconKey: string;
    longitude: number;
    latitude: number;
  }) => invoke<Restaurant>("create_restaurant", { input }),
  updateProfile: (input: {
    id: string;
    name: string;
    cuisineKey: string;
    iconKey: string;
    mapIconScale: number;
    phone?: string | null;
    openingHoursText?: string | null;
    addressNote?: string | null;
  }) => invoke<Restaurant>("update_restaurant_profile", { input }),
  updateStatus: (
    input: { id: string } & Partial<
      Pick<MapRestaurant, "overallRating" | "visitStatus" | "affectionStatus" | "isBookmarked">
    >,
  ) => invoke<Restaurant>("update_restaurant_status", { input }),
  setPositionLocked: (id: string, positionLocked: boolean) =>
    invoke<Restaurant>("set_restaurant_map_position_locked", { input: { id, positionLocked } }),
  move: (id: string, longitude: number, latitude: number) =>
    invoke<Restaurant>("move_restaurant", { input: { id, longitude, latitude } }),
  softDelete: (id: string) => invoke<void>("soft_delete_restaurant", { input: { id } }),
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string) => invoke<Tag>("create_tag", { input: { name } }),
  renameTag: (id: string, name: string) => invoke<Tag>("rename_tag", { input: { id, name } }),
  deleteTag: (id: string) => invoke<void>("delete_tag", { input: { id } }),
  setTag: (restaurantId: string, tagId: string, associated: boolean) =>
    invoke<void>("set_restaurant_tag", { input: { restaurantId, tagId, associated } }),
  listFoodLogs: (restaurantId: string, cursor?: string | null, limit = 20) =>
    invoke<FoodLogPage>("list_food_logs", { input: { restaurantId, cursor: cursor ?? null, limit } }),
  createFoodLog: (input: FoodLogInput) => invoke<FoodLog>("create_food_log", { input }),
  updateFoodLog: (id: string, input: Omit<FoodLogInput, "restaurantId">) =>
    invoke<FoodLog>("update_food_log", { input: { id, ...input } }),
  softDeleteFoodLog: (id: string) => invoke<void>("soft_delete_food_log", { input: { id } }),
  listMedia: (input: {
    restaurantId?: string;
    foodLogId?: string;
    category?: MediaCategory;
    cursor?: string | null;
    limit?: number;
  }) => invoke<MediaPage>("list_media", { input }),
  importMedia: (input: {
    restaurantId: string;
    foodLogId?: string | null;
    category: MediaCategory;
    paths: string[];
  }) => invoke<MediaImportResult>("import_media", { input }),
  updateMediaCategory: (id: string, category: MediaCategory) =>
    invoke<Media>("update_media_category", { input: { id, category } }),
  attachMediaToLog: (id: string, foodLogId?: string | null) =>
    invoke<Media>("attach_media_to_log", { input: { id, foodLogId: foodLogId ?? null } }),
  softDeleteMedia: (id: string) => invoke<void>("soft_delete_media", { input: { id } }),
  restoreMedia: (id: string) => invoke<Media>("restore_media", { input: { id } }),
  openMediaOriginal: (id: string) => invoke<void>("open_media_original", { input: { id } }),
  listTrash: () => invoke<TrashSnapshot>("list_trash", { input: {} }),
  restoreTrashItem: (entityType: TrashEntityType, id: string) =>
    invoke<void>("restore_trash_item", { input: { entity: entityType, id } }),
  permanentlyDeleteTrashItem: (entityType: TrashEntityType, id: string) =>
    invoke<void>("permanently_delete_trash_item", { input: { entity: entityType, id } }),
  createBackup: (destinationPath: string) =>
    invoke<BackupResult>("create_backup", { input: { destinationPath } }),
  inspectBackup: (sourcePath: string) => invoke<RestorePreview>("inspect_backup", { input: { sourcePath } }),
  restoreBackup: (sourcePath: string) => invoke<BackupResult>("restore_backup", { input: { sourcePath } }),
  openDataDirectory: () => invoke<void>("open_app_data_directory"),
};
