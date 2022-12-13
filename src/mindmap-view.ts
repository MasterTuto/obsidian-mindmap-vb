import {
  EventRef,
  ItemView,
  Menu,
  Vault,
  Workspace,
  WorkspaceLeaf,
} from "obsidian";
import { Transformer, builtInPlugins } from "markmap-lib";
import { Markmap, loadCSS, loadJS, deriveOptions } from "markmap-view";
import { INode, IMarkmapOptions, IMarkmapJSONOptions } from "markmap-common";
import { D3ZoomEvent, ZoomTransform, zoomIdentity } from "d3-zoom";

import { FRONT_MATTER_REGEX, MD_VIEW_TYPE, MM_VIEW_TYPE } from "./constants";
import ObsidianMarkmap from "./obsidian-markmap-plugin";
import { createSVG, getComputedCss, removeExistingSVG } from "./markmap-svg";
import { copyImageToClipboard } from "./copy-image";
import { htmlEscapePlugin } from "./html-escape-plugin";
import { MindMapSettings } from "./settings";
import { FrontmatterOptions } from "./@types/models";

type CustomFrontmatter = {
  markmap: IMarkmapJSONOptions & { screenshotFgColor: string };
};

export default class MindmapView extends ItemView {
  filePath: string;
  fileName: string;
  linkedLeaf: WorkspaceLeaf;
  displayText: string;
  currentMd: string;
  vault: Vault;
  workspace: Workspace;
  listeners: EventRef[];
  emptyDiv: HTMLDivElement;
  svg: SVGElement;
  obsMarkmap: ObsidianMarkmap;
  isLeafPinned: boolean = false;
  pinAction: HTMLElement;
  settings: MindMapSettings;
  currentTransform: ZoomTransform;
  markmapSVG: Markmap;
  transformer: Transformer;
  options: Partial<IMarkmapOptions>;
  frontmatterOptions: FrontmatterOptions;
  hasFit: boolean;

  groupEventListenerFn: () => unknown;

  // workaround for zooming

  getViewType(): string {
    return MM_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.displayText ?? "Mind Map";
  }

  getIcon() {
    return "dot-network";
  }

  onMoreOptionsMenu(menu: Menu) {
    menu
      .addItem((item) =>
        item
          .setIcon("pin")
          .setTitle("Pin")
          .onClick(() => this.pinCurrentLeaf())
      )
      .addSeparator()
      .addItem((item) =>
        item
          .setIcon("image-file")
          .setTitle("Copy screenshot")
          .onClick(() =>
            copyImageToClipboard(
              this.settings,
              this.markmapSVG,
              this.frontmatterOptions
            )
          )
      )
      .addSeparator()
      .addItem((item) =>
        item
          .setIcon("folder")
          .setTitle("Collapse All")
          .onClick(() => this.collapseAll())
      );

    menu.showAtPosition({ x: 0, y: 0 });
  }

  constructor(
    settings: MindMapSettings,
    leaf: WorkspaceLeaf,
    initialFileInfo: { path: string; basename: string }
  ) {
    super(leaf);
    this.settings = settings;
    this.filePath = initialFileInfo.path;
    this.fileName = initialFileInfo.basename;
    this.vault = this.app.vault;
    this.workspace = this.app.workspace;

    this.transformer = new Transformer([...builtInPlugins, htmlEscapePlugin]);
    this.svg = createSVG(this.containerEl, this.settings.lineHeight);
    this.hasFit = false;

    this.createMarkmapSvg();

    this.setListenersUp();

    this.overrideStopPropagation();
  }

  createMarkmapSvg() {
    const { font } = getComputedCss(this.containerEl);

    this.options = {
      autoFit: false,
      color: this.applyColor.bind(this),
      duration: 500,
      style: (id) => `${id} * {font: ${font}}`,
      nodeMinHeight: this.settings.nodeMinHeight ?? 16,
      spacingVertical: this.settings.spacingVertical ?? 5,
      spacingHorizontal: this.settings.spacingHorizontal ?? 80,
      paddingX: this.settings.paddingX ?? 8,
      embedGlobalCSS: true,
      fitRatio: 1,
    };

    this.markmapSVG = Markmap.create(this.svg, this.options);
  }

  reloadMarkmapSVG() {
    this.markmapSVG.destroy();
    this.createMarkmapSvg();
    this.update(this.currentMd);
  }

  setListenersUp() {
    let lastTimeout: number | undefined;
    this.listeners = [
      this.workspace.on("quick-preview", (_, content) => {
        if (lastTimeout) {
          window.clearTimeout(lastTimeout);
        }

        lastTimeout = window.setTimeout(async () => {
          await this.update(content);
          lastTimeout = undefined;
        }, 300);
      }),
      this.workspace.on("resize", async () => await this.checkAndUpdate()),
      this.workspace.on("active-leaf-change", async (a) => {
        await this.checkAndUpdate();
      }),
      this.workspace.on(
        "layout-change",
        async () => await this.checkAndUpdate()
      ),
      this.workspace.on("css-change", async () => await this.checkAndUpdate()),
      this.workspace.on("file-menu", async () => await this.checkAndUpdate()),
      this.workspace.on("editor-menu", async () => await this.checkAndUpdate()),
      this.workspace.on(
        "editor-paste",
        async () => await this.checkAndUpdate()
      ),
      this.workspace.on("editor-drop", async () => await this.checkAndUpdate()),
      this.workspace.on("codemirror", async () => await this.checkAndUpdate()),
      this.leaf.on(
        "group-change",
        async (group) => await this.updateLinkedLeaf(group, this)
      ),
    ];
  }

  overrideStopPropagation() {
    const oldStopProgation = MouseEvent.prototype.stopPropagation;

    MouseEvent.prototype.stopPropagation = function () {
      const target = this.target as HTMLElement;

      if (
        target.tagName.toLowerCase() != "div" ||
        target.tagName.toLowerCase() != "foreignObject"
      )
        oldStopProgation.bind(this)();

      let parent = target;
      while (parent) {
        if (parent == this.svg) return;
        parent = parent.parentElement;
      }

      oldStopProgation.bind(this)();
    };
  }

  async onOpen() {
    this.obsMarkmap = new ObsidianMarkmap(this.vault);
    this.workspace.onLayoutReady(async () => {
      console.log("Comecou agr");
      await this.update();
      console.log("Terminou agr");
    });
  }

  async onClose() {
    this.listeners.forEach((listener) => this.workspace.offref(listener));
  }

  async updateLinkedLeaf(group: string, mmView: MindmapView) {
    if (group === null) {
      mmView.linkedLeaf = undefined;
      return;
    }
    const mdLinkedLeaf = mmView.workspace
      .getGroupLeaves(group)
      .filter((l) => l?.view?.getViewType() === MM_VIEW_TYPE)[0];
    mmView.linkedLeaf = mdLinkedLeaf;

    await this.update();
  }

  pinCurrentLeaf() {
    this.isLeafPinned = true;
    this.pinAction = this.addAction(
      "filled-pin",
      "Pin",
      () => this.unPin(),
      20
    );
    this.pinAction.addClass("is-active");
  }

  unPin() {
    this.isLeafPinned = false;
    this.pinAction.parentNode.removeChild(this.pinAction);
  }

  collapseAll() {
    this.markmapSVG.setData(this.markmapSVG.state.data, {
      ...this.options,
      initialExpandLevel: 0,
    });
  }

  async update(markdown?: string) {
    if (markdown && typeof markdown === "string") this.currentMd = markdown;
    else await this.readMarkDown();

    if (!this.currentMd) return;

    let { root, scripts, styles, frontmatter } = await this.transformMarkdown();

    const actualFrontmatter = frontmatter as CustomFrontmatter;

    const options = deriveOptions(frontmatter?.markmap);
    this.frontmatterOptions = {
      ...options,
      screenshotFgColor: actualFrontmatter?.markmap?.screenshotFgColor,
    };

    if (styles) loadCSS(styles);
    if (scripts) loadJS(scripts);

    this.renderMarkmap(root, options, frontmatter?.markmap ?? {});

    this.displayText =
      this.fileName != undefined ? `Mind Map of ${this.fileName}` : "Mind Map";

    setTimeout(() => this.applyWidths(), 100);
  }

  async checkAndUpdate() {
    try {
      if (await this.checkActiveLeaf()) {
        await this.update();
      }
    } catch (error) {
      console.error(error);
    }
  }

  async checkActiveLeaf() {
    if (this.app.workspace.activeLeaf?.view?.getViewType() !== MD_VIEW_TYPE) {
      return false;
    }

    const pathHasChanged = this.readFilePath();
    const markDownHasChanged = await this.readMarkDown();
    const updateRequired = pathHasChanged || markDownHasChanged;
    return updateRequired;
  }

  readFilePath() {
    const fileInfo = (this.getLeafTarget().view as any).file;
    const pathHasChanged = this.filePath != fileInfo.path;
    this.filePath = fileInfo.path;
    this.fileName = fileInfo.basename;
    return pathHasChanged;
  }

  getLeafTarget() {
    if (!this.isLeafPinned) {
      this.linkedLeaf = this.app.workspace.activeLeaf;
    }
    return this.linkedLeaf != undefined
      ? this.linkedLeaf
      : this.app.workspace.activeLeaf;
  }

  async readMarkDown() {
    try {
      let md = await this.app.vault.adapter.read(this.filePath);
      const markDownHasChanged = this.currentMd != md;
      this.currentMd = md;
      return markDownHasChanged;
    } catch (error) {
      console.log(error);
    }
  }

  async transformMarkdown() {
    let { root, features, frontmatter } = this.transformer.transform(
      this.currentMd
    );

    const { scripts, styles } = this.transformer.getUsedAssets(features);

    this.obsMarkmap.updateInternalLinks(root);
    return { root, scripts, styles, frontmatter };
  }

  applyColor(frontmatterColors: string[]) {
    return ({ depth }: INode) => {
      if (this.settings.onlyUseDefaultColor) return this.settings.defaultColor;

      const colors = frontmatterColors?.length
        ? frontmatterColors
        : [this.settings.color1, this.settings.color2, this.settings.color3];

      if (frontmatterColors?.length) return colors[depth % colors.length];
      else
        return depth < colors.length
          ? colors[depth]
          : this.settings.defaultColor;
    };
  }

  hexToRgb(hex: string) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);

    const red = parseInt(result[1], 16);
    const green = parseInt(result[2], 16);
    const blue = parseInt(result[3], 16);

    return result ? `rgb(${red}, ${green}, ${blue})` : null;
  }

  applyWidths() {
    if (!this.svg) return;

    const colors = [
      this.settings.color1Thickness,
      this.settings.color2Thickness,
      this.settings.color3Thickness,
      this.settings.defaultColorThickness,
    ];

    this.svg
      .querySelectorAll("path.markmap-link")
      .forEach((el: SVGPathElement) => {
        const colorIndex = Math.min(3, parseInt(el.dataset.depth));

        el.style.strokeWidth = `${colors[colorIndex]}`;
      });

    this.svg.querySelectorAll("g.markmap-node").forEach((el: SVGGElement) => {
      const line = el.querySelector("line");

      const colorIndex = Math.min(3, parseInt(el.dataset.depth));
      line.style.strokeWidth = `${colors[colorIndex]}`;
    });

    this.svg.querySelectorAll("circle").forEach((el) => {
      this.groupEventListenerFn = () =>
        setTimeout(() => this.applyWidths(), 50);
      el.addEventListener("click", this.groupEventListenerFn);
    });
  }

  async renderMarkmap(
    root: INode,
    { color, ...frontmatterOptions }: Partial<IMarkmapOptions>,
    frontmatter: Partial<IMarkmapJSONOptions> = {}
  ) {
    try {
      const { font } = getComputedCss(this.containerEl);

      const colorFn =
        this.settings.coloring === "depth"
          ? this.applyColor(frontmatter?.color)
          : color;

      console.log("Colorfn: ", colorFn);

      this.options = {
        autoFit: false,
        style: (id) => `${id} * {font: ${font}}`,
        nodeMinHeight: this.settings.nodeMinHeight ?? 16,
        spacingVertical: this.settings.spacingVertical ?? 5,
        spacingHorizontal: this.settings.spacingHorizontal ?? 80,
        paddingX: this.settings.paddingX ?? 8,
        embedGlobalCSS: true,
        fitRatio: 1,
        initialExpandLevel: this.settings.initialExpandLevel ?? -1,
        maxWidth: this.settings.maxWidth ?? 0,
        duration: this.settings.animationDuration ?? 500,
      };

      if (colorFn) {
        this.options.color = colorFn;
      }

      this.markmapSVG.setData(root, {
        ...this.options,
        ...frontmatterOptions,
      });

      if (!this.hasFit) {
        this.markmapSVG.fit();
        this.hasFit = true;
      }
    } catch (error) {
      console.error(error);
    }
  }

  displayEmpty(display: boolean) {
    if (this.emptyDiv === undefined) {
      const div = document.createElement("div");
      div.className = "pane-empty";
      div.innerText = "No content found";
      removeExistingSVG();
      this.containerEl.children[1].appendChild(div);
      this.emptyDiv = div;
    }
    this.emptyDiv.toggle(display);
  }
}
