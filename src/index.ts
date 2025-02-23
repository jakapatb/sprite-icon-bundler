import * as fs from 'fs/promises';
import camelcase from 'camelcase';
import { resolve } from 'path';
import { optimize, Config as SvgoConfig } from 'svgo';
import crypto from 'crypto';
import { transform } from './transform';
import { Config } from './types';
import { ensureWrite } from './utils/file';
const defaultSvgoConfig: SvgoConfig = {
  plugins: ['removeDimensions', 'sortAttrs'],
  js2svg: {
    indent: 2,
    pretty: true,
  },
};

const getSvgIconContent = (
  id: string,
  spriteHref: string,
  spriteFileName: string,
): string => `<svg fill="none" stroke="currentColor" stroke-width="0" color="currentColor" width="1em" height="1em" >
<use href="${spriteHref}/${spriteFileName}.svg#${id}" />
</svg>`;

const getIcons = async (
  input: string,
  spriteHref: string,
  spriteFileName: string,
): Promise<IconData[]> => {
  const files = (await fs.readdir(input)).filter((file) => file.endsWith('.svg'));

  return Promise.all(
    files.map(async (file) => {
      const componentName = `${camelcase(file.replace(/\.svg$/, ''), {
        pascalCase: true,
      })}Icon`;

      const svg = getSvgIconContent(componentName, spriteHref, spriteFileName);

      return { svg, componentName };
    }),
  );
};

interface IconData {
  svg: string;
  componentName: string;
}

const buildIcons = async (
  config: Config,
  spriteHref: string,
  spriteFileName: string,
): Promise<IconData[]> => {
  const icons = await getIcons(config.input, spriteHref, spriteFileName);

  // Generate icons
  await Promise.all(
    icons.flatMap(async ({ componentName, svg }) => {
      const content = await transform.react(svg, componentName).catch((error) => {
        console.log(`Error building ${componentName}`);
        throw error;
      });

      // const types = `import * as React from 'react';\ndeclare function ${componentName}(props: React.ComponentProps<'svg'> & { title?: string, titleId?: string, id?:string }): React.ReactElement;\nexport default ${componentName};\n`;

      return [
        ensureWrite(`${config.output.distPath}/${componentName}.tsx`, content),
        // ...(types ? [ensureWrite(`${config.output.distPath}/${componentName}.d.ts`, types)] : []),
      ];
    }),
  );

  return icons;
};

const buildSpriteSVG = async (
  config: Config,
  suffix: string,
  svgoConfig: SvgoConfig = defaultSvgoConfig,
): Promise<string> => {
  const { input, output } = config;
  // Read and filter SVG files
  const files = await fs.readdir(input);
  const svgFiles = files.filter((file) => file.endsWith('.svg')).sort();

  // Transform SVGs into symbols
  const symbols = await Promise.all(
    svgFiles.map(async (file) => {
      const content = await fs.readFile(resolve(input, file), 'utf-8');
      const symbolId = camelcase(file.replace('.svg', suffix), {
        pascalCase: true,
      });

      const viewBox = content.match(/viewBox="([^"]+)"/)?.[0] ?? '';

      // Convert SVG to symbol
      return content
        .replace(/<svg[^>]+>/, `<symbol id="${symbolId}" ${viewBox}>`)
        .replace(/<\/svg>/, '</symbol>')
        .replace(/xmlns="[^"]+"/, '');
    }),
  );

  const sprite = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
    `<defs>`,
    ...symbols,
    `</defs>`,
    `</svg>`,
  ].join('\n');

  // Optimize and save sprite
  const optimized = optimize(sprite, svgoConfig);

  // Generate unique filename
  let filename = config.output.spriteName ? `${config.output.spriteName}` : `sprite-icons`;

  if (config.output.hashSuffix) {
    const hash = crypto.createHash('md5').update(sprite).digest('hex').slice(0, 8);
    filename = `${filename}-${hash}`;
  }

  if (Array.isArray(output.spritePath)) {
    await Promise.all(
      output.spritePath.map((dir) => ensureWrite(`${dir}/${filename}.svg`, optimized.data)),
    );
  } else {
    await ensureWrite(`${output.spritePath}/${filename}.svg`, optimized.data);
  }
  return filename;
};

const readConfig = async (): Promise<Config> => {
  try {
    const configPath = resolve(process.cwd(), 'spricon.config.ts');
    const { default: config } = await import(configPath);
    return {
      ...config,
      input: resolve(process.cwd(), config.input),
      output: {
        ...config.output,
        spritePath: Array.isArray(config.output.spritePath)
          ? config.output.spritePath.map((path: string) => resolve(process.cwd(), path))
          : resolve(process.cwd(), config.output.spritePath),
      },
    };
  } catch (error) {
    throw new Error('Could not load spricon.config.ts configuration file');
  }
};

const exportAll = (icons: IconData[], includeExtension = true): string => {
  return icons
    .map(({ componentName }) => {
      const extension = includeExtension ? '.js' : '';
      if (componentName === 'Icon') {
        return `export * from './Icon'`;
      }
      return `export { default as ${componentName} } from './${componentName}${extension}'`;
    })
    .join('\n');
};

const buildIndex = async (icons: IconData[], outputPath: string) => {
  await ensureWrite(`${outputPath}/index.ts`, exportAll(icons, false));
  // await ensureWrite(`${outputPath}/index.js`, exportAll(icons));
};

const buildIconComponent = async (
  icons: IconData[],
  spriteFileName: string,
  spriteHref: string | undefined = '',
  outputPath: string,
): Promise<IconData[]> => {
  const iconNames = icons.map((icon) => icon.componentName.replace(/Icon$/, ''));

  const component = `import { SVGProps, memo } from 'react';

export const ICON_NAME_LIST = [${iconNames.map((name) => `'${name}'`).join(', ')}] as const;
export type IconName = typeof ICON_NAME_LIST[number];

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  return <svg color="currentColor" width="1em" height="1em" {...props}>
  <use href={${`\`${spriteHref ?? ''}/${spriteFileName}.svg#\${name}Icon\``}} />
  </svg>
}

export default memo(Icon);`;

  await ensureWrite(`${outputPath}/Icon.tsx`, component);

  return [...icons, { componentName: 'Icon', svg: component }];
};

const cleanupOldSpriteFiles = async (config: Config) => {
  // Remove old sprite
  try {
    if (Array.isArray(config.output.spritePath)) {
      for (const dir of config.output.spritePath) {
        const exists = await fs
          .access(dir)
          .then(() => true)
          .catch(() => false);

        if (!exists) continue;

        const files = await fs.readdir(dir);
        const spriteFiles = files.filter((file) =>
          file.startsWith(config.output.spriteName ?? 'sprite-icons'),
        );
        await Promise.all(spriteFiles.map((file) => fs.rm(resolve(dir, file))));
      }
    } else {
      const exists = await fs
        .access(config.output.spritePath)
        .then(() => true)
        .catch(() => false);

      if (!exists) return;

      const files = await fs.readdir(config.output.spritePath);
      const spriteFiles = files.filter((file) =>
        file.startsWith(config.output.spriteName ?? 'sprite-icons'),
      );
      await Promise.all(spriteFiles.map((file) => fs.rm(file)));
    }
  } catch (error) {
    // console.log('Error cleaning up old sprite files', error);
  }
};

const cleanupOldDistFiles = async (config: Config) => {
  const distDir = resolve(config.output.distPath);
  const exists = await fs
    .access(distDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) return;

  await fs.rm(distDir, { recursive: true, force: true });
};

export async function buildSpriteIcons(configInput?: Config) {
  const config = configInput || (await readConfig());
  await cleanupOldSpriteFiles(config);
  await cleanupOldDistFiles(config);
  const spriteFileName = await buildSpriteSVG(config, 'Icon', config.svgoConfig);
  const icons = await buildIcons(config, config.output.spriteHref ?? '', spriteFileName);
  const iconsWithComponent = await buildIconComponent(
    icons,
    spriteFileName,
    config.output.spriteHref,
    config.output.distPath,
  );
  await buildIndex(iconsWithComponent, config.output.distPath);
}

export * from './types';

export default buildSpriteIcons;
