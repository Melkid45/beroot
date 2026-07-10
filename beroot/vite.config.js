import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, normalizePath } from 'vite';

const root = process.cwd();
const srcDir = path.resolve(root, 'src');

function resolveFrom(file, request) {
  const normalizedRequest = request.trim();

  if (normalizedRequest === '@') {
    return srcDir;
  }

  if (normalizedRequest.startsWith('@/')) {
    return path.resolve(srcDir, normalizedRequest.slice(2));
  }

  const relativePath = path.resolve(path.dirname(file), normalizedRequest);

  if (existsSync(relativePath)) {
    return relativePath;
  }

  return path.resolve(root, normalizedRequest);
}

function resolvePublicPath(request, file) {
  if (/^(?:\/|[a-z]+:|#)/i.test(request)) {
    return request;
  }

  const absolutePath = request.startsWith('@/')
    ? path.resolve(srcDir, request.slice(2))
    : path.resolve(path.dirname(file), request);

  return normalizePath(`/${path.relative(root, absolutePath)}`);
}

function resolveScssHref(href, file) {
  if (/^(?:\/|[a-z]+:)/i.test(href)) {
    return href;
  }

  const absolutePath = href.startsWith('@/')
    ? path.resolve(srcDir, href.slice(2))
    : path.resolve(path.dirname(file), href);

  return normalizePath(`/${path.relative(root, absolutePath)}`);
}

function rewriteAliasAttributes(html, file) {
  const attrPattern = /\b(src|href|poster)=["'](@\/[^"']+)["']/gi;
  const srcsetPattern = /\bsrcset=["']([^"']*@\/[^"']*)["']/gi;

  return html
    .replace(attrPattern, (_, attr, request) => `${attr}="${resolvePublicPath(request, file)}"`)
    .replace(srcsetPattern, (_, value) => {
      const rewrittenValue = value
        .split(',')
        .map((item) => {
          const [request, ...descriptor] = item.trim().split(/\s+/);
          const publicPath = request.startsWith('@/') ? resolvePublicPath(request, file) : request;

          return [publicPath, ...descriptor].join(' ');
        })
        .join(', ');

      return `srcset="${rewrittenValue}"`;
    });
}

function extractScssLinks(html, file, styles) {
  return html.replace(
    /<link\b[^>]*\bhref=["']([^"']+\.s[ac]ss)["'][^>]*>\s*/gi,
    (tag, href) => {
      if (/^[a-z]+:/i.test(href)) {
        return tag;
      }

      styles.add(resolveScssHref(href, file));
      return '';
    },
  );
}

function injectStyleLinks(html, styles) {
  if (styles.size === 0) {
    return html;
  }

  const links = Array.from(styles)
    .map((href) => `  <link rel="stylesheet" href="${href}">`)
    .join('\n');

  return html.replace('</head>', `${links}\n</head>`);
}

function renderIncludes(html, file, stack, styles) {
  const preparedHtml = rewriteAliasAttributes(extractScssLinks(html, file, styles), file);

  return preparedHtml.replace(/<!--\s*@include\s+(.+?)\s*-->/g, (_, request) => {
    const includePath = resolveFrom(file, request);

    if (!existsSync(includePath)) {
      throw new Error(`HTML include not found: ${request} in ${file}`);
    }

    if (stack.has(includePath)) {
      throw new Error(`Circular HTML include: ${includePath}`);
    }

    stack.add(includePath);
    const partial = readFileSync(includePath, 'utf8');
    const renderedPartial = renderIncludes(partial, includePath, stack, styles);
    stack.delete(includePath);

    return renderedPartial;
  });
}

function renderPage(html, file) {
  const stack = new Set([file]);
  const pageStyles = new Set();
  const pageHtml = renderIncludes(html, file, stack, pageStyles);
  const layoutMatch = pageHtml.match(/<!--\s*@layout\s+(.+?)\s*-->/);

  if (!layoutMatch) {
    return injectStyleLinks(pageHtml, pageStyles);
  }

  const layoutPath = resolveFrom(file, layoutMatch[1]);

  if (!existsSync(layoutPath)) {
    throw new Error(`HTML layout not found: ${layoutMatch[1]} in ${file}`);
  }

  const headerMatch = pageHtml.match(/<!--\s*@header\s+(white|default)\s*-->/i);
  const headerFile = headerMatch?.[1].toLowerCase() === 'white' ? 'header-white.html' : 'header.html';
  const headerInclude = `<!-- @include ../_components/header/${headerFile} -->`;
  const pageContent = pageHtml
    .replace(layoutMatch[0], '')
    .replace(headerMatch?.[0] ?? '', '')
    .trim();
  const layoutStyles = new Set();
  const layoutHtml = readFileSync(layoutPath, 'utf8')
    .replace(/<!--\s*@header\s*-->/g, headerInclude);
  const renderedLayout = renderIncludes(layoutHtml, layoutPath, stack, layoutStyles);
  const styles = new Set([...layoutStyles, ...pageStyles]);
  const page = renderedLayout.replace(/<!--\s*@slot\s*-->/g, pageContent);

  return injectStyleLinks(page, styles);
}

function htmlLayouts() {
  return {
    name: 'html-layouts',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        return renderPage(html, context.filename);
      },
    },
    handleHotUpdate(context) {
      if (context.file.endsWith('.html')) {
        context.server.ws.send({ type: 'full-reload' });
      }
    },
  };
}

function getHtmlEntries() {
  return Object.fromEntries(
    readdirSync(root)
      .filter((file) => file.endsWith('.html'))
      .map((file) => [path.parse(file).name, path.resolve(root, file)]),
  );
}

export default defineConfig({
  plugins: [htmlLayouts()],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      input: getHtmlEntries(),
    },
  },
});
