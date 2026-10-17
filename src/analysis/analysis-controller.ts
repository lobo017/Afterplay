import {
  GameTree,
  nagToGlyph,
  type GameNode,
  type PgnArrowAnnotation,
  type PgnHighlightAnnotation,
} from '../core/game-tree';
import { parsePgn, writePgn } from '../core/pgn';
import {
  DEFAULT_POSITION,
  RulesAdapter,
  validateChessFen,
  type ExecutedMove,
  type MoveInput,
  type Square,
} from '../core/rules';
import {
  EngineCancelledError,
  EngineClient,
  type EngineAnalysisResult,
  type EngineLine,
} from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import {
  BOARD_THEMES,
  DEFAULT_BOARD_THEME,
  DEFAULT_PIECE_SET,
  PIECE_SETS,
  type BoardThemeId,
  type PieceSetId,
} from '../render/themes';
import {
  EngineLinesPanel,
  type GhostLinePreviewPayload,
  type SelectLineVariationPayload,
} from './engine-lines-panel';
import {
  EvalBar,
  formatEvalBarScore,
  pgnEvalToUciScore,
} from './eval-bar';
import {
  formatOpeningBadge,
  lookupGameOpening,
  lookupOpeningByFen,
} from './opening-lookup';
import { PositionEditor } from './position-editor';
import {
  detectOpponentThreat,
  type ThreatDetectionResult,
} from './threat-detector';

export interface AnalysisControllerOptions {
  container: HTMLElement;
  engine: EngineClient;
  /** Optional dedicated secondary engine for null-move threat searches so main MultiPV analysis is never interrupted. */
  threatEngine?: EngineClient;
  initialFen?: string;
  initialPgn?: string;
  initialMultiPv?: number;
  analysisDepth?: number;
  threatSearchDepth?: number;
  engineEnabled?: boolean;
  showBestMoveArrow?: boolean;
  showThreatArrow?: boolean;
  initialActive?: boolean;
}

/**
 * Phase 4 Analysis Board Controller.
 * Coordinates:
 * - Animated, mate-aware EvalBar that flips with the board
 * - Live MultiPV (1–5) EngineLinesPanel with ghost piece hover previews & click-to-insert variations
 * - Best-move arrow, null-move Threat arrow, and user-drawn arrows/circles (with modifier keys & PGN [%cal]/[%csl] sync)
 * - Opening lookup (ECO code + opening name from data/openings.json)
 * - Interactive GameTree variation navigator (promote, demote, delete, comments, NAGs)
 * - Position Editor with live FEN validation
 * - PGN Import / Export
 * - Keyboard controls (Left/Right, Up/Down variation switch, Home/End, F flip, Space engine toggle)
 */
export class AnalysisController {
  private readonly container: HTMLElement;
  private readonly engine: EngineClient;
  private readonly threatEngine: EngineClient;
  private readonly audio: CathedralAudio;

  private evalBar!: EvalBar;
  private board!: BoardRenderer;
  private linesPanel!: EngineLinesPanel;
  private positionEditor!: PositionEditor;

  private gameTree: GameTree;
  private adapter: RulesAdapter;

  private isActive: boolean;
  private engineEnabled: boolean;
  private multipv: number;
  private analysisDepth: number;
  private threatSearchDepth: number;
  private showBestMoveArrow: boolean;
  private showThreatArrow: boolean;
  private editorVisible = false;

  private analysisGeneration = 0;
  private analysisAbortController: AbortController | null = null;
  private threatAbortController: AbortController | null = null;
  private pendingRafId: number | null = null;

  private latestLines: EngineLine[] = [];
  private latestDepth = 0;
  private latestNps = 0;
  private latestScoreWhite: UciScore = { type: 'cp', value: 0 };
  private latestThreat: ThreatDetectionResult | null = null;

  // Cached DOM references
  private openingEcoEl!: HTMLElement;
  private openingNameEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private evalPillEl!: HTMLElement;
  private threatBadgeEl!: HTMLElement;
  private fenDisplayEl!: HTMLElement;
  private treeContainerEl!: HTMLElement;
  private commentInputEl!: HTMLInputElement;
  private pgnTextareaEl!: HTMLTextAreaElement;
  private pgnStatusEl!: HTMLElement;
  private editorMountEl!: HTMLElement;
  private toggleEditorBtnEl!: HTMLButtonElement;
  private promoteVarBtnEl!: HTMLButtonElement;
  private promoteMainBtnEl!: HTMLButtonElement;
  private demoteVarBtnEl!: HTMLButtonElement;
  private deleteVarBtnEl!: HTMLButtonElement;

  constructor(options: AnalysisControllerOptions) {
    this.container = options.container;
    this.engine = options.engine;
    this.threatEngine = options.threatEngine ?? options.engine;
    this.isActive = options.initialActive ?? true;
    this.engineEnabled = options.engineEnabled ?? true;
    this.multipv = Math.max(1, Math.min(5, options.initialMultiPv ?? 3));
    this.analysisDepth = options.analysisDepth ?? 16;
    this.threatSearchDepth = options.threatSearchDepth ?? 8;
    this.showBestMoveArrow = options.showBestMoveArrow ?? true;
    this.showThreatArrow = options.showThreatArrow ?? true;

    this.audio = new CathedralAudio({ enabled: true, volume: 0.75 });

    if (options.initialPgn) {
      this.gameTree = parsePgn(options.initialPgn);
    } else {
      const startFen = options.initialFen?.trim() || DEFAULT_POSITION;
      this.gameTree = new GameTree(startFen);
    }
    this.adapter = new RulesAdapter(this.gameTree.currentNode.fen, {
      chess960: this.gameTree.isChess960(),
    });

    this.mountLayout();
    this.bindKeyboardShortcuts();
    this.syncAllFromCurrentNode(false);
  }

  private mountLayout(): void {
    this.container.innerHTML = `
      <div class="wc-analysis-layout" data-testid="analysis-layout">
        <!-- Left column: Opening Bar + (EvalBar + 2D Board) + Transport & Arrow Controls -->
        <div class="wc-analysis-board-column">
          <div class="wc-opening-banner" data-testid="opening-badge">
            <span class="wc-opening-eco" data-testid="opening-eco">A00</span>
            <span class="wc-opening-name" data-testid="opening-name">Starting Position</span>
            <span class="wc-threat-pill" data-testid="threat-move-badge" title="Opponent threat from null-move search">
              Threat: —
            </span>
          </div>

          <div class="wc-board-with-eval" data-testid="board-with-eval">
            <div class="wc-eval-bar-mount" data-testid="eval-bar-mount"></div>
            <div class="wc-board-mount" data-testid="analysis-board-mount"></div>
          </div>

          <!-- Transport Navigation & Quick Toggles -->
          <div class="wc-analysis-transport-bar">
            <div class="wc-transport-buttons" role="group" aria-label="Move navigation">
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-nav-start" title="Start of game (Home)">
                ⏮
              </button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-nav-prev" title="Previous move (←)">
                ◀
              </button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-nav-next" title="Next move (→)">
                ▶
              </button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-nav-end" title="End of game (End)">
                ⏭
              </button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-flip-board" title="Flip board (F)">
                Flip Board
              </button>
              <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-clear-arrows" title="Clear user arrows and circles">
                Clear Shapes
              </button>
            </div>

            <div class="wc-arrow-toggles">
              <label class="wc-checkbox-label" title="Show Stockfish best move arrow">
                <input type="checkbox" data-testid="toggle-best-arrow" ${this.showBestMoveArrow ? 'checked' : ''} />
                <span>Best Arrow</span>
              </label>
              <label class="wc-checkbox-label" title="Show opponent threat arrow from null-move search">
                <input type="checkbox" data-testid="toggle-threat-arrow" ${this.showThreatArrow ? 'checked' : ''} />
                <span>Threat Arrow</span>
              </label>
            </div>
          </div>

          <div class="wc-fen-readout-row">
            <span class="wc-field-label">FEN</span>
            <code class="wc-fen-readout" data-testid="analysis-current-fen">${this.adapter.fen()}</code>
          </div>
        </div>

        <!-- Right column: Status, MultiPV Engine Lines, Variation Tree, Annotations, Position Editor, PGN Import/Export -->
        <aside class="wc-side-panel wc-analysis-side-panel" aria-label="Analysis Tools">
          <div class="wc-status-header">
            <div class="wc-status-banner" data-testid="analysis-status-banner" role="status" aria-live="polite">
              White to move
            </div>
            <div class="wc-eval-pill" data-testid="analysis-eval-pill" title="Current Evaluation (White perspective)">
              +0.00
            </div>
          </div>

          <!-- Engine Lines Panel (1-5 MultiPV lines, hover for ghost pieces, click to insert variation) -->
          <div data-testid="engine-lines-mount"></div>

          <!-- Move Tree & Variations Panel -->
          <div class="wc-moves-panel">
            <div class="wc-panel-section-title">
              <span>Game Tree &amp; Variations</span>
              <div class="wc-variation-actions">
                <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-promote-variation" title="Promote variation up">
                  ↑ Promote
                </button>
                <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-promote-mainline" title="Promote variation to main line">
                  ⇈ Main Line
                </button>
                <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-demote-variation" title="Demote variation down">
                  ↓ Demote
                </button>
                <button type="button" class="wc-btn wc-btn-danger wc-btn-xs" data-testid="btn-delete-variation" title="Delete move / variation">
                  ✕ Delete
                </button>
              </div>
            </div>
            <div class="wc-move-tree" data-testid="analysis-move-tree" role="tree" aria-label="Game moves and variations"></div>
          </div>

          <!-- Move Comment & NAG Symbols -->
          <div class="wc-annotation-bar">
            <div class="wc-nag-row" role="group" aria-label="Move annotation symbols">
              ${[
                { code: 1, sym: '!', title: 'Good move (!)' },
                { code: 2, sym: '?', title: 'Mistake (?)' },
                { code: 3, sym: '!!', title: 'Brilliant move (!!)' },
                { code: 4, sym: '??', title: 'Blunder (??)' },
                { code: 5, sym: '!?', title: 'Interesting move (!?)' },
                { code: 6, sym: '?!', title: 'Dubious move (?!)' },
              ]
                .map(
                  (n) =>
                    `<button type="button" class="wc-btn wc-btn-ghost wc-btn-xs wc-nag-btn" data-nag-code="${n.code}" data-testid="btn-nag-${n.code}" title="${n.title}">${n.sym}</button>`,
                )
                .join('')}
            </div>
            <input
              type="text"
              class="wc-input wc-input-sm"
              data-testid="input-move-comment"
              placeholder="Add comment on current move..."
              aria-label="Move comment"
            />
          </div>

          <!-- Position Editor Toggle & Mount -->
          <div class="wc-editor-section">
            <div class="wc-action-row">
              <button
                type="button"
                class="wc-btn wc-btn-secondary wc-btn-sm"
                data-testid="btn-toggle-editor"
                aria-expanded="false"
              >
                Position Editor
              </button>
              <button
                type="button"
                class="wc-btn wc-btn-secondary wc-btn-sm"
                data-testid="btn-reset-analysis"
              >
                Reset Start Pos
              </button>
              <select class="wc-select wc-select-sm" data-testid="select-analysis-theme" aria-label="Board theme">
                ${Object.values(BOARD_THEMES)
                  .map(
                    (t) =>
                      `<option value="${t.id}" ${t.id === DEFAULT_BOARD_THEME ? 'selected' : ''}>${t.label}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div data-testid="position-editor-mount" hidden></div>
          </div>

          <!-- PGN Import / Export -->
          <div class="wc-pgn-section">
            <div class="wc-panel-section-title">
              <span>PGN Import &amp; Export</span>
              <span class="wc-pgn-status" data-testid="pgn-status">Ready</span>
            </div>
            <textarea
              class="wc-textarea wc-input-mono"
              data-testid="textarea-pgn"
              rows="3"
              placeholder="Paste PGN with variations, comments, NAGs, [%eval], [%cal], [%csl]..."
              aria-label="PGN text"
            ></textarea>
            <div class="wc-action-row">
              <button type="button" class="wc-btn wc-btn-primary wc-btn-sm" data-testid="btn-import-pgn">
                Load PGN
              </button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-export-pgn">
                Export PGN
              </button>
              <select class="wc-select wc-select-sm" data-testid="select-analysis-piece-set" aria-label="Piece set">
                ${Object.values(PIECE_SETS)
                  .map(
                    (s) =>
                      `<option value="${s.id}" ${s.id === DEFAULT_PIECE_SET ? 'selected' : ''}>${s.label}</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>
        </aside>
      </div>
    `;

    this.openingEcoEl = this.container.querySelector(
      '[data-testid="opening-eco"]',
    ) as HTMLElement;
    this.openingNameEl = this.container.querySelector(
      '[data-testid="opening-name"]',
    ) as HTMLElement;
    this.statusTextEl = this.container.querySelector(
      '[data-testid="analysis-status-banner"]',
    ) as HTMLElement;
    this.evalPillEl = this.container.querySelector(
      '[data-testid="analysis-eval-pill"]',
    ) as HTMLElement;
    this.threatBadgeEl = this.container.querySelector(
      '[data-testid="threat-move-badge"]',
    ) as HTMLElement;
    this.fenDisplayEl = this.container.querySelector(
      '[data-testid="analysis-current-fen"]',
    ) as HTMLElement;
    this.treeContainerEl = this.container.querySelector(
      '[data-testid="analysis-move-tree"]',
    ) as HTMLElement;
    this.commentInputEl = this.container.querySelector(
      '[data-testid="input-move-comment"]',
    ) as HTMLInputElement;
    this.pgnTextareaEl = this.container.querySelector(
      '[data-testid="textarea-pgn"]',
    ) as HTMLTextAreaElement;
    this.pgnStatusEl = this.container.querySelector(
      '[data-testid="pgn-status"]',
    ) as HTMLElement;
    this.editorMountEl = this.container.querySelector(
      '[data-testid="position-editor-mount"]',
    ) as HTMLElement;
    this.toggleEditorBtnEl = this.container.querySelector(
      '[data-testid="btn-toggle-editor"]',
    ) as HTMLButtonElement;
    this.promoteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-promote-variation"]',
    ) as HTMLButtonElement;
    this.promoteMainBtnEl = this.container.querySelector(
      '[data-testid="btn-promote-mainline"]',
    ) as HTMLButtonElement;
    this.demoteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-demote-variation"]',
    ) as HTMLButtonElement;
    this.deleteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-delete-variation"]',
    ) as HTMLButtonElement;

    const evalBarMount = this.container.querySelector(
      '[data-testid="eval-bar-mount"]',
    ) as HTMLElement;
    const boardMount = this.container.querySelector(
      '[data-testid="analysis-board-mount"]',
    ) as HTMLElement;
    const linesMount = this.container.querySelector(
      '[data-testid="engine-lines-mount"]',
    ) as HTMLElement;

    this.evalBar = new EvalBar(evalBarMount, {
      flipped: false,
      initialScoreWhite: { type: 'cp', value: 0 },
    });

    this.board = new BoardRenderer(boardMount, {
      flipped: false,
      interactiveColor: 'both',
      enablePremoves: false,
      autoQueen: false,
      confirmMove: false,
      captureEffects: true,
      boardTheme: DEFAULT_BOARD_THEME,
      pieceSet: DEFAULT_PIECE_SET,
      onMove: (move, wasDragged) => {
        this.handleBoardMove(move, wasDragged);
      },
      onSelectSquare: () => {
        this.audio.playSelect();
      },
      onSquareEdit: (sq) => {
        if (!this.editorVisible) return false;
        return this.positionEditor.handleBoardSquareClick(sq);
      },
      onAnnotationsChange: (arrows, highlights) => {
        this.handleBoardAnnotationsChange(arrows, highlights);
      },
      onFlipChange: (flipped) => {
        this.evalBar.setFlipped(flipped);
      },
    });

    this.linesPanel = new EngineLinesPanel(linesMount, {
      initialMultiPv: this.multipv,
      initialEnabled: this.engineEnabled,
      onToggleEngine: (enabled) => {
        this.setEngineEnabled(enabled);
      },
      onChangeMultiPv: (mpv) => {
        this.setMultiPv(mpv);
      },
      onHoverLine: (preview) => {
        this.handleHoverEngineLine(preview);
      },
      onSelectLine: (selection) => {
        this.handleSelectEngineLineVariation(selection);
      },
    });

    this.positionEditor = new PositionEditor(this.editorMountEl, {
      initialFen: this.adapter.fen(),
      pieceSet: DEFAULT_PIECE_SET,
      onApplyPosition: (fen) => {
        this.loadFen(fen);
      },
      onPreviewSquaresChange: (squares) => {
        const validation = this.positionEditor.getValidation();
        if (!validation.ok) {
          this.board.setArbitrarySquares(squares);
        }
      },
    });

    this.bindUiEvents();
  }

  private bindUiEvents(): void {
    this.container
      .querySelector('[data-testid="btn-nav-start"]')
      ?.addEventListener('click', () => {
        this.goToStart();
      });

    this.container
      .querySelector('[data-testid="btn-nav-prev"]')
      ?.addEventListener('click', () => {
        this.goBack();
      });

    this.container
      .querySelector('[data-testid="btn-nav-next"]')
      ?.addEventListener('click', () => {
        this.goForward();
      });

    this.container
      .querySelector('[data-testid="btn-nav-end"]')
      ?.addEventListener('click', () => {
        this.goToEnd();
      });

    this.container
      .querySelector('[data-testid="btn-flip-board"]')
      ?.addEventListener('click', () => {
        this.flipBoard();
      });

    this.container
      .querySelector('[data-testid="btn-clear-arrows"]')
      ?.addEventListener('click', () => {
        this.board.clearUserAnnotations();
      });

    const bestArrowCheck = this.container.querySelector(
      '[data-testid="toggle-best-arrow"]',
    ) as HTMLInputElement | null;
    bestArrowCheck?.addEventListener('change', () => {
      this.setShowBestMoveArrow(bestArrowCheck.checked);
    });

    const threatArrowCheck = this.container.querySelector(
      '[data-testid="toggle-threat-arrow"]',
    ) as HTMLInputElement | null;
    threatArrowCheck?.addEventListener('change', () => {
      this.setShowThreatArrow(threatArrowCheck.checked);
    });

    this.promoteVarBtnEl.addEventListener('click', () => {
      this.promoteCurrentVariation();
    });

    this.promoteMainBtnEl.addEventListener('click', () => {
      this.promoteCurrentToMainLine();
    });

    this.demoteVarBtnEl.addEventListener('click', () => {
      this.demoteCurrentVariation();
    });

    this.deleteVarBtnEl.addEventListener('click', () => {
      this.deleteCurrentVariation();
    });

    this.treeContainerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const nodeEl = target.closest('[data-node-id]') as HTMLElement | null;
      if (!nodeEl) return;
      const nodeId = nodeEl.getAttribute('data-node-id');
      if (nodeId) {
        this.goToNode(nodeId);
      }
    });

    this.commentInputEl.addEventListener('input', () => {
      const curr = this.gameTree.currentNode;
      this.gameTree.setComment(curr.id, this.commentInputEl.value);
      this.renderMoveTree();
      this.syncPgnTextarea();
    });

    const nagButtons = this.container.querySelectorAll('[data-nag-code]');
    nagButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = Number(btn.getAttribute('data-nag-code'));
        if (!code) return;
        const curr = this.gameTree.currentNode;
        if (curr.ply === 0) return;
        if (curr.nags.includes(code)) {
          this.gameTree.removeNag(curr.id, code);
        } else {
          // Replace primary move assessment NAGs (1..6) if another one is already set
          for (let c = 1; c <= 6; c++) {
            if (c !== code && curr.nags.includes(c)) {
              this.gameTree.removeNag(curr.id, c);
            }
          }
          this.gameTree.addNag(curr.id, code);
        }
        this.syncAnnotationControls();
        this.renderMoveTree();
        this.syncPgnTextarea();
      });
    });

    this.toggleEditorBtnEl.addEventListener('click', () => {
      this.setEditorVisible(!this.editorVisible);
    });

    this.container
      .querySelector('[data-testid="btn-reset-analysis"]')
      ?.addEventListener('click', () => {
        this.loadFen(DEFAULT_POSITION);
      });

    const themeSelect = this.container.querySelector(
      '[data-testid="select-analysis-theme"]',
    ) as HTMLSelectElement | null;
    themeSelect?.addEventListener('change', () => {
      this.board.setBoardTheme(themeSelect.value as BoardThemeId);
    });

    const pieceSetSelect = this.container.querySelector(
      '[data-testid="select-analysis-piece-set"]',
    ) as HTMLSelectElement | null;
    pieceSetSelect?.addEventListener('change', () => {
      const setId = pieceSetSelect.value as PieceSetId;
      this.board.setPieceSet(setId);
      this.positionEditor.setPieceSet(setId);
    });

    this.container
      .querySelector('[data-testid="btn-import-pgn"]')
      ?.addEventListener('click', () => {
        this.importPgn(this.pgnTextareaEl.value);
      });

    this.container
      .querySelector('[data-testid="btn-export-pgn"]')
      ?.addEventListener('click', () => {
        this.exportPgn();
      });
  }

  private readonly handleWindowKeyDown = (e: KeyboardEvent): void => {
    if (!this.isActive || !this.container.isConnected) return;

    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) return;

    switch (e.key) {
      case 'ArrowLeft': {
        e.preventDefault();
        this.goBack();
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        this.goForward();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        this.switchVariation(-1);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        this.switchVariation(1);
        break;
      }
      case 'Home': {
        e.preventDefault();
        this.goToStart();
        break;
      }
      case 'End': {
        e.preventDefault();
        this.goToEnd();
        break;
      }
      case 'f':
      case 'F': {
        e.preventDefault();
        this.flipBoard();
        break;
      }
      case ' ': {
        e.preventDefault();
        this.setEngineEnabled(!this.engineEnabled);
        break;
      }
    }
  };

  private bindKeyboardShortcuts(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown);
    }
  }

  public setActive(active: boolean): void {
    if (this.isActive === active) return;
    this.isActive = active;
    if (!active) {
      this.cancelActiveSearches();
      this.board.setGhostPreview(null);
      return;
    }
    this.startPositionAnalysis();
  }

  public isCurrentlyActive(): boolean {
    return this.isActive;
  }

  public setEditorVisible(visible: boolean): void {
    this.editorVisible = visible;
    this.editorMountEl.hidden = !visible;
    this.toggleEditorBtnEl.setAttribute('aria-expanded', String(visible));
    this.toggleEditorBtnEl.classList.toggle('wc-btn-primary', visible);
    if (!visible) {
      this.positionEditor.setTool('pointer');
      this.board.setPosition(this.adapter, {
        lastMove: this.getLastMoveCoords(this.gameTree.currentNode),
        wasDragged: true,
        triggerCaptureParticles: false,
        preserveAnalysisArrows: true,
      });
    } else {
      this.positionEditor.setFen(this.adapter.fen(), false);
    }
  }

  public isEditorVisible(): boolean {
    return this.editorVisible;
  }

  public flipBoard(): void {
    const next = !this.board.isFlipped();
    this.board.setFlipped(next);
    this.evalBar.setFlipped(next);
  }

  public setEngineEnabled(enabled: boolean): void {
    this.engineEnabled = enabled;
    this.linesPanel.setEnabled(enabled);
    if (!enabled) {
      this.cancelActiveSearches();
      this.board.setBestMoveArrow(null);
      this.board.setThreatMoveArrow(null);
      this.board.setGhostPreview(null);
      this.threatBadgeEl.textContent = 'Threat: Off';
      return;
    }
    this.startPositionAnalysis();
  }

  public isEngineEnabled(): boolean {
    return this.engineEnabled;
  }

  public setMultiPv(multipv: number): void {
    const clamped = Math.max(1, Math.min(5, Math.floor(multipv)));
    if (this.multipv === clamped) return;
    this.multipv = clamped;
    this.linesPanel.setMultiPv(clamped);
    if (this.engineEnabled) {
      this.startPositionAnalysis();
    }
  }

  public getMultiPv(): number {
    return this.multipv;
  }

  public setShowBestMoveArrow(show: boolean): void {
    this.showBestMoveArrow = show;
    const checkbox = this.container.querySelector(
      '[data-testid="toggle-best-arrow"]',
    ) as HTMLInputElement | null;
    if (checkbox && checkbox.checked !== show) {
      checkbox.checked = show;
    }
    this.syncAnalysisArrows();
  }

  public setShowThreatArrow(show: boolean): void {
    this.showThreatArrow = show;
    const checkbox = this.container.querySelector(
      '[data-testid="toggle-threat-arrow"]',
    ) as HTMLInputElement | null;
    if (checkbox && checkbox.checked !== show) {
      checkbox.checked = show;
    }
    if (show && !this.latestThreat && this.engineEnabled) {
      void this.runThreatSearchForCurrentNode(
        this.analysisGeneration,
        this.adapter.fen(),
      );
    } else {
      this.syncAnalysisArrows();
    }
  }

  private getLastMoveCoords(
    node: GameNode,
  ): { from: Square; to: Square } | null {
    if (node.from && node.to) {
      return { from: node.from, to: node.to };
    }
    return null;
  }

  private handleBoardMove(moveInput: MoveInput, wasDragged: boolean): void {
    let executed: ExecutedMove;
    try {
      const probe = this.adapter.clone();
      executed = probe.move(moveInput);
    } catch {
      this.board.setPosition(this.adapter, {
        lastMove: this.getLastMoveCoords(this.gameTree.currentNode),
        wasDragged: true,
        triggerCaptureParticles: false,
      });
      return;
    }

    this.gameTree.addMove(executed.uci);
    this.syncAllFromCurrentNode(wasDragged);
  }

  private handleBoardAnnotationsChange(
    arrows: PgnArrowAnnotation[],
    highlights: PgnHighlightAnnotation[],
  ): void {
    const curr = this.gameTree.currentNode;
    this.gameTree.setArrows(curr.id, arrows);
    this.gameTree.setHighlights(curr.id, highlights);
    this.syncPgnTextarea();
  }

  public handleHoverEngineLine(preview: GhostLinePreviewPayload | null): void {
    if (!preview || preview.moves.length === 0) {
      this.board.setGhostPreview(null);
      return;
    }
    this.board.setGhostPreview({
      targetFen: preview.targetFen,
      moves: preview.moves.map((m) => ({ from: m.from, to: m.to })),
    });
  }

  public handleSelectEngineLineVariation(
    selection: SelectLineVariationPayload,
  ): void {
    if (selection.moves.length === 0) return;

    const anchorNodeId = this.gameTree.currentNodeId;
    let currId = anchorNodeId;
    for (const move of selection.moves) {
      try {
        const added = this.gameTree.addMove(move.uci, {
          fromNodeId: currId,
        });
        currId = added.id;
      } catch {
        break;
      }
    }

    this.syncAllFromCurrentNode(false);
  }

  public goToNode(nodeId: string): GameNode {
    const node = this.gameTree.goToNode(nodeId);
    this.syncAllFromCurrentNode(false);
    return node;
  }

  public goToStart(): GameNode {
    const node = this.gameTree.goToStart();
    this.syncAllFromCurrentNode(false);
    return node;
  }

  public goToEnd(): GameNode {
    const node = this.gameTree.goToEnd();
    this.syncAllFromCurrentNode(false);
    return node;
  }

  public goBack(): GameNode | null {
    const node = this.gameTree.goBack();
    if (node) {
      this.syncAllFromCurrentNode(false);
    }
    return node;
  }

  public goForward(variationIndex = 0): GameNode | null {
    const node = this.gameTree.goForward(variationIndex);
    if (node) {
      this.syncAllFromCurrentNode(false);
    }
    return node;
  }

  /**
   * Switches between sibling variations (Up = -1, Down = +1).
   * - If the current node's parent has multiple children, switches among those siblings.
   * - Otherwise walks up to the nearest variation branch point with sibling variations.
   * - Otherwise if the current node itself has multiple children, steps into the first/next variation child.
   */
  public switchVariation(direction: -1 | 1): GameNode | null {
    const curr = this.gameTree.currentNode;

    // 1. Walk from curr upward to find the nearest ancestor whose parent has >1 child
    let cursor: GameNode | undefined = curr;
    while (cursor && cursor.parentId) {
      const parent = this.gameTree.getNode(cursor.parentId);
      if (parent && parent.children.length > 1) {
        const idx = parent.children.indexOf(cursor);
        const nextIdx =
          (idx + direction + parent.children.length) % parent.children.length;
        const targetSibling = parent.children[nextIdx];
        if (targetSibling && targetSibling.id !== cursor.id) {
          return this.goToNode(targetSibling.id);
        }
        break;
      }
      cursor = parent;
    }

    // 2. If curr itself has multiple children (e.g. sitting at root before a branched move)
    if (curr.children.length > 1) {
      const targetIdx = direction > 0 ? 1 : curr.children.length - 1;
      const targetChild = curr.children[targetIdx];
      if (targetChild) {
        return this.goToNode(targetChild.id);
      }
    }

    return null;
  }

  public promoteCurrentVariation(): boolean {
    const ok = this.gameTree.promoteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public promoteCurrentToMainLine(): boolean {
    const ok = this.gameTree.promoteToMainLine(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public demoteCurrentVariation(): boolean {
    const ok = this.gameTree.demoteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public deleteCurrentVariation(): boolean {
    const ok = this.gameTree.deleteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.syncAllFromCurrentNode(false);
    }
    return ok;
  }

  public loadFen(fen: string): boolean {
    const validation = validateChessFen(fen.trim());
    if (!validation.ok) {
      return false;
    }
    this.gameTree = new GameTree(fen.trim(), {
      chess960: validation.isChess960,
    });
    this.positionEditor.setTool('pointer');
    this.syncAllFromCurrentNode(false);
    return true;
  }

  public loadGameTree(tree: GameTree): void {
    this.gameTree = GameTree.fromJSON(tree.toJSON());
    this.syncAllFromCurrentNode(false);
  }

  public importPgn(pgnText: string): boolean {
    try {
      const parsed = parsePgn(pgnText);
      this.gameTree = parsed;
      this.pgnStatusEl.textContent = 'PGN Loaded';
      this.pgnStatusEl.setAttribute('data-status', 'ok');
      this.syncAllFromCurrentNode(false);
      return true;
    } catch (err) {
      this.pgnStatusEl.textContent =
        err instanceof Error ? err.message : 'Invalid PGN';
      this.pgnStatusEl.setAttribute('data-status', 'error');
      return false;
    }
  }

  public exportPgn(): string {
    const pgn = writePgn(this.gameTree);
    this.pgnTextareaEl.value = pgn;
    this.pgnStatusEl.textContent = 'PGN Exported';
    this.pgnStatusEl.setAttribute('data-status', 'ok');
    return pgn;
  }

  private syncPgnTextarea(): void {
    this.pgnTextareaEl.value = writePgn(this.gameTree);
  }

  private syncAllFromCurrentNode(wasDragged: boolean): void {
    const node = this.gameTree.currentNode;
    this.adapter = new RulesAdapter(node.fen, {
      chess960: this.gameTree.isChess960(),
    });

    const lastMove = this.getLastMoveCoords(node);
    this.board.setPosition(this.adapter, {
      lastMove,
      wasDragged,
      triggerCaptureParticles: false,
      preserveAnalysisArrows: false,
    });

    // Restore node's [%cal] and [%csl] user annotations onto the board
    this.board.setUserAnnotations(node.arrows, node.highlights);

    // Sync PositionEditor FEN input
    this.positionEditor.setFen(node.fen, false);
    this.fenDisplayEl.textContent = node.fen;

    // Sync Opening Lookup
    const opening =
      lookupOpeningByFen(node.fen) ??
      lookupGameOpening(this.gameTree, node.id);
    if (opening) {
      this.openingEcoEl.textContent = opening.eco;
      this.openingNameEl.textContent = opening.name;
    } else {
      this.openingEcoEl.textContent = 'A00';
      this.openingNameEl.textContent =
        node.ply === 0 ? 'Starting Position' : formatOpeningBadge(null);
    }

    // Sync status banner
    if (this.adapter.isCheckmate()) {
      const winner = this.adapter.turn() === 'w' ? 'Black' : 'White';
      this.statusTextEl.textContent = `Checkmate — ${winner} wins`;
    } else if (this.adapter.isDraw()) {
      this.statusTextEl.textContent = 'Draw position';
    } else {
      const side = this.adapter.turn() === 'w' ? 'White' : 'Black';
      this.statusTextEl.textContent = `${side} to move${
        this.adapter.inCheck() ? ' — Check!' : ''
      }`;
    }

    // Seed eval bar from node.eval if present before live Stockfish results arrive
    if (node.eval) {
      const initialScore = pgnEvalToUciScore(node.eval);
      this.latestScoreWhite = initialScore;
      this.evalBar.setScoreWhite(initialScore);
      this.evalPillEl.textContent = formatEvalBarScore(initialScore);
    } else if (node.ply === 0) {
      this.latestScoreWhite = { type: 'cp', value: 0 };
      this.evalBar.setScoreWhite(this.latestScoreWhite);
      this.evalPillEl.textContent = '+0.00';
    }

    this.syncAnnotationControls();
    this.syncVariationButtonsState();
    this.renderMoveTree();
    this.syncPgnTextarea();

    this.startPositionAnalysis();
  }

  private syncAnnotationControls(): void {
    const curr = this.gameTree.currentNode;
    if (this.commentInputEl.value !== curr.comment) {
      this.commentInputEl.value = curr.comment;
    }

    const nagButtons =
      this.container.querySelectorAll<HTMLButtonElement>('[data-nag-code]');
    nagButtons.forEach((btn) => {
      const code = Number(btn.getAttribute('data-nag-code'));
      const active = curr.nags.includes(code);
      btn.classList.toggle('wc-btn-primary', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.disabled = curr.ply === 0;
    });
  }

  private syncVariationButtonsState(): void {
    const curr = this.gameTree.currentNode;
    const isRoot = curr.parentId === null;
    this.promoteVarBtnEl.disabled = isRoot;
    this.promoteMainBtnEl.disabled = isRoot;
    this.demoteVarBtnEl.disabled = isRoot;
    this.deleteVarBtnEl.disabled = isRoot;
  }

  private renderMoveTree(): void {
    const root = this.gameTree.root;
    if (root.children.length === 0 && !root.comment) {
      this.treeContainerEl.innerHTML = `<div class="wc-move-empty">Play moves on the board, click an engine line, or load a PGN to build variations.</div>`;
      return;
    }

    const activeId = this.gameTree.currentNodeId;
    const htmlParts: string[] = [];

    if (root.comment) {
      htmlParts.push(
        `<span class="wc-tree-comment" data-testid="tree-root-comment">{ ${this.escapeHtml(root.comment)} }</span> `,
      );
    }

    const renderNodeMoveToken = (
      node: GameNode,
      forceMoveNumber: boolean,
    ): string => {
      const isWhite = node.moveColor === 'w';
      const prefix = isWhite
        ? `${node.moveNumber}.`
        : forceMoveNumber
          ? `${node.moveNumber}...`
          : '';
      const nagsText = node.nags.map((n) => nagToGlyph(n)).join('');
      const evalTag = node.eval
        ? `<span class="wc-tree-eval-tag">${formatEvalBarScore(pgnEvalToUciScore(node.eval))}</span>`
        : '';
      const activeClass = node.id === activeId ? 'wc-tree-node-active' : '';
      const preCommentHtml = node.preComment
        ? `<span class="wc-tree-comment">{ ${this.escapeHtml(node.preComment)} }</span> `
        : '';
      const postCommentHtml = node.comment
        ? ` <span class="wc-tree-comment">{ ${this.escapeHtml(node.comment)} }</span>`
        : '';

      return `${preCommentHtml}<button type="button" class="wc-tree-node ${activeClass}" data-node-id="${node.id}" data-node-san="${this.escapeHtml(node.san)}" data-testid="tree-node-${node.id}">${
        prefix ? `<span class="wc-tree-num">${prefix}</span>` : ''
      }<span class="wc-tree-san">${this.escapeHtml(node.san)}${this.escapeHtml(nagsText)}</span>${evalTag}</button>${postCommentHtml}`;
    };

    const renderBranch = (
      startNode: GameNode,
      forceFirstMoveNum: boolean,
    ): string => {
      const segments: string[] = [];
      let curr: GameNode | undefined = startNode;
      let forceNum = forceFirstMoveNum;

      while (curr) {
        const parent = curr.parentId
          ? this.gameTree.getNode(curr.parentId)
          : undefined;
        const siblings =
          parent && parent.children[0]?.id === curr.id
            ? parent.children.slice(1)
            : [];

        segments.push(renderNodeMoveToken(curr, forceNum));
        forceNum = false;

        if (siblings.length > 0) {
          for (const sib of siblings) {
            segments.push(
              `<span class="wc-tree-variation" data-testid="tree-variation-${sib.id}">( ${renderBranch(sib, true)} )</span>`,
            );
          }
          forceNum = true;
        }

        curr = curr.children[0];
      }

      return segments.join(' ');
    };

    const firstMain = root.children[0];
    if (firstMain) {
      htmlParts.push(renderBranch(firstMain, true));
    }

    this.treeContainerEl.innerHTML = htmlParts.join(' ');
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private cancelActiveSearches(): void {
    this.analysisGeneration++;
    if (this.analysisAbortController) {
      this.analysisAbortController.abort();
      this.analysisAbortController = null;
    }
    if (this.threatAbortController) {
      this.threatAbortController.abort();
      this.threatAbortController = null;
    }
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }
  }

  private startPositionAnalysis(): void {
    this.cancelActiveSearches();

    const gen = this.analysisGeneration;
    const node = this.gameTree.currentNode;
    const fen = node.fen;
    const chess960 = this.gameTree.isChess960();

    this.latestLines = [];
    this.latestThreat = null;

    if (!this.engineEnabled) {
      this.linesPanel.setEnabled(false);
      return;
    }

    if (this.adapter.isGameOver()) {
      if (this.adapter.isCheckmate()) {
        const whiteMated = this.adapter.turn() === 'w';
        const mateScore: UciScore = {
          type: 'mate',
          value: whiteMated ? -1 : 1,
        };
        this.latestScoreWhite = mateScore;
        this.evalBar.setScoreWhite(mateScore);
        this.evalPillEl.textContent = formatEvalBarScore(mateScore);
      } else {
        const drawScore: UciScore = { type: 'cp', value: 0 };
        this.latestScoreWhite = drawScore;
        this.evalBar.setScoreWhite(drawScore);
        this.evalPillEl.textContent = '0.00';
      }
      this.linesPanel.clear(fen);
      this.threatBadgeEl.textContent = 'Threat: —';
      return;
    }

    if (!this.isActive) {
      this.linesPanel.clear(fen);
      return;
    }

    this.linesPanel.clear(fen);

    const sharedWorker = this.threatEngine === this.engine;
    if (!sharedWorker && this.showThreatArrow) {
      void this.runThreatSearchForCurrentNode(gen, fen);
    }

    const ac = new AbortController();
    this.analysisAbortController = ac;

    void this.engine
      .analyze({
        fen,
        depth: this.analysisDepth,
        multipv: this.multipv,
        chess960,
        priority: 'live',
        preempt: true,
        signal: ac.signal,
        onInfo: (snapshot: EngineAnalysisResult) => {
          if (gen !== this.analysisGeneration || ac.signal.aborted) return;
          this.latestLines = snapshot.lines;
          this.latestDepth = snapshot.depth;
          this.latestNps = snapshot.nps;
          this.scheduleUiUpdateFromEngine(node.id, fen, chess960);
        },
      })
      .then((finalResult: EngineAnalysisResult) => {
        if (gen !== this.analysisGeneration || ac.signal.aborted) return;
        this.latestLines = finalResult.lines;
        this.latestDepth = finalResult.depth;
        this.latestNps = finalResult.nps;
        this.applyEngineSnapshotImmediate(node.id, fen, chess960);

        if (sharedWorker && this.showThreatArrow) {
          void this.runThreatSearchForCurrentNode(gen, fen);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof EngineCancelledError) return;
      });
  }

  private async runThreatSearchForCurrentNode(
    gen: number,
    fen: string,
  ): Promise<void> {
    if (this.threatAbortController) {
      this.threatAbortController.abort();
    }
    const threatAc = new AbortController();
    this.threatAbortController = threatAc;
    this.threatBadgeEl.textContent = 'Threat: ...';

    const threat = await detectOpponentThreat(this.threatEngine, fen, {
      depth: this.threatSearchDepth,
      chess960: this.gameTree.isChess960(),
      signal: threatAc.signal,
    });

    if (gen !== this.analysisGeneration || threatAc.signal.aborted) {
      return;
    }

    this.latestThreat = threat;
    if (threat) {
      this.threatBadgeEl.textContent = `Threat: ${threat.san}`;
    } else {
      this.threatBadgeEl.textContent = 'Threat: None';
    }
    this.syncAnalysisArrows();
  }

  private scheduleUiUpdateFromEngine(
    nodeId: string,
    fen: string,
    chess960: boolean,
  ): void {
    if (this.pendingRafId !== null) return;
    this.pendingRafId = requestAnimationFrame(() => {
      this.pendingRafId = null;
      this.applyEngineSnapshotImmediate(nodeId, fen, chess960);
    });
  }

  private applyEngineSnapshotImmediate(
    nodeId: string,
    fen: string,
    chess960: boolean,
  ): void {
    if (this.gameTree.currentNodeId !== nodeId) return;

    const topLine = this.latestLines[0];
    if (topLine) {
      this.latestScoreWhite = topLine.scoreWhite;
      this.evalBar.setScoreWhite(topLine.scoreWhite);
      const formatted = formatEvalBarScore(topLine.scoreWhite);
      if (this.evalPillEl.textContent !== formatted) {
        this.evalPillEl.textContent = formatted;
      }

      // Store evaluation on current move node so PGN export includes [%eval]
      if (nodeId !== this.gameTree.root.id) {
        if (topLine.scoreWhite.type === 'mate') {
          this.gameTree.setEval(nodeId, {
            mate: topLine.scoreWhite.value,
            depth: topLine.depth,
          });
        } else {
          this.gameTree.setEval(nodeId, {
            cp: topLine.scoreWhite.value,
            depth: topLine.depth,
          });
        }
      }
    }

    this.linesPanel.updateLines(fen, this.latestLines, {
      depth: this.latestDepth,
      nps: this.latestNps,
      chess960,
    });

    this.syncAnalysisArrows();
  }

  private syncAnalysisArrows(): void {
    const topLine = this.latestLines[0];
    const bestUci = topLine?.pv[0];
    if (
      this.engineEnabled &&
      this.showBestMoveArrow &&
      bestUci &&
      bestUci.length >= 4
    ) {
      const from = bestUci.slice(0, 2) as Square;
      const to = bestUci.slice(2, 4) as Square;
      this.board.setBestMoveArrow({ from, to });
    } else {
      this.board.setBestMoveArrow(null);
    }

    if (
      this.engineEnabled &&
      this.showThreatArrow &&
      this.latestThreat
    ) {
      this.board.setThreatMoveArrow({
        from: this.latestThreat.from,
        to: this.latestThreat.to,
      });
    } else {
      this.board.setThreatMoveArrow(null);
    }
  }

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getEvalBar(): EvalBar {
    return this.evalBar;
  }

  public getLinesPanel(): EngineLinesPanel {
    return this.linesPanel;
  }

  public getPositionEditor(): PositionEditor {
    return this.positionEditor;
  }

  public getGameTree(): GameTree {
    return this.gameTree;
  }

  public getAdapter(): RulesAdapter {
    return this.adapter;
  }

  public getLatestThreat(): ThreatDetectionResult | null {
    return this.latestThreat;
  }

  public getLatestLines(): EngineLine[] {
    return [...this.latestLines];
  }

  public destroy(): void {
    this.cancelActiveSearches();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleWindowKeyDown);
    }
    this.board.destroy();
  }
}
