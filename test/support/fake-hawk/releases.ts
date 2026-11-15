/** A source map file of a release as the release worker keeps it. */
export interface FakeReleaseFile {
  /** Name of the map file, as uploaded. */
  mapFileName: string;
  /** Name of the bundle the map describes: the `file` field of the map, or the map name without `.map`. */
  originFileName: string;
  /** Text of the map. */
  content: string;
}

/** A release of a project. */
export interface FakeRelease {
  /** Release name. */
  release: string;
  /** Map files saved for it. */
  files: FakeReleaseFile[];
}

/** Releases the release worker saved, by project. */
export interface FakeReleases {
  /**
   * Saves files into a release, leaving out a map that is already saved under the same name, as the worker does.
   * @param projectId Project the release belongs to.
   * @param release Release name.
   * @param files Files to save.
   */
  save(projectId: string, release: string, files: readonly FakeReleaseFile[]): void;
  /**
   * Finds a release.
   * @param projectId Project the release belongs to.
   * @param release Release name.
   * @returns The release, undefined when nothing was saved for it.
   */
  find(projectId: string, release: string): FakeRelease | undefined;
}

/**
 * Creates an empty set of releases.
 * @returns Releases with no project.
 */
export function createFakeReleases(): FakeReleases {
  const releases = new Map<string, FakeRelease>();
  const keyOf = (projectId: string, release: string): string => `${projectId}\n${release}`;

  return {
    save: (projectId, release, files) => {
      const key = keyOf(projectId, release);
      const known = releases.get(key) ?? { release,
        files: [] };

      for (const file of files) {
        if (!known.files.some(saved => saved.mapFileName === file.mapFileName)) {
          known.files.push(file);
        }
      }

      releases.set(key, known);
    },
    find: (projectId, release) => releases.get(keyOf(projectId, release)),
  };
}
