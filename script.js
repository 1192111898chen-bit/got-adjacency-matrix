const dataFiles = {
  nodes: "got-nodes.csv",
  edges: "got-edges.csv"
};

const LOUVAIN = { name: "Louvain", resolution: 1, seed: 42 };
const MARGIN = { top: 112, right: 12, bottom: 12, left: 116 };
const CATEGORY_COLORS = [
  "#7561A8", "#4E789A", "#4C8E88", "#B27A48", "#887394",
  "#6D8990", "#A36F61", "#628464", "#A18A4D", "#6678A8"
];
const matrixElement = d3.select("#matrix");
const tooltip = d3.select("#tooltip");
const viewport = document.querySelector("#matrix-viewport");
const searchInput = document.querySelector("#character-search");
const suggestions = document.querySelector("#search-suggestions");
const searchMessage = document.querySelector("#search-message");
const sortInput = document.querySelector("#sort-order");
const weightInput = document.querySelector("#weight-filter");
const summary = document.querySelector("#matrix-summary");
const detailPanel = document.querySelector("#detail-panel");
const numberInput = document.querySelector("#weight-number");
const clearSelectionButton = document.querySelector("#clear-selection");
const selectionSummary = document.querySelector("#selection-summary");
const selectionSummaryText = document.querySelector("#selection-summary-text");
const interactionStatus = document.querySelector("#interaction-status");
const accessibleRelationships = document.querySelector("#accessible-relationships");
const matrixEmptyState = document.querySelector("#matrix-empty-state");
const searchContainer = document.querySelector(".search-control");

let nodes = [];
let edges = [];
let nodeById = new Map();
let edgeByPair = new Map();
let edgeById = new Map();
let matrixCells = [];
let communityInfo = [];
let selectedId = "";
let selectedPair = null;
let pairReturnPersonId = "";
let hoveredCell = null;
let focusedCell = null;
let colorForWeight = () => "#dfe5e8";
let weightDomain = [0, 1];
let thresholdMaximum = 1;
let currentCellSize = 6;
let currentOrderedNodes = [];
let currentIndexById = new Map();
let currentSvg = null;
let matrixScale = 1;
let sqrtColorScale = d3.scaleLinear().domain([0, 1]).range([0.08, 0.9]).clamp(true);
let activeSuggestionIndex = -1;
let pendingRenderFrame = 0;
let observedViewportWidth = 0;
let currentMatrixTransform = "translate(0,0)";
let interactionsBound = false;
let resizeObserver;

function setDataControlsDisabled(disabled) {
  document.querySelectorAll(".toolbar select, .toolbar input, .toolbar [data-view], .toolbar [data-threshold], .zoom-cta, #clear-selection, #reset-view")
    .forEach((control) => { control.disabled = disabled; });
}

async function loadNetwork() {
  const errorPanel = document.querySelector("#load-error");
  errorPanel.hidden = true;
  document.querySelector("#load-error-summary").textContent = "";
  document.querySelector("#load-error-detail").textContent = "";
  setDataControlsDisabled(true);
  summary.textContent = "Loading network data…";
  try {
    const [nodeRows, edgeRows] = await Promise.all([d3.csv(dataFiles.nodes), d3.csv(dataFiles.edges)]);
    const errors = validateData(nodeRows, edgeRows);
    if (errors.length) {
      throw new Error(`Data validation failed:\n${errors.join("\n")}`);
    }

    nodes = nodeRows.map((row) => ({
      id: row.Id.trim(),
      label: row.Label.trim(),
      degree: 0,
      strength: 0,
      communityId: ""
    }));
    edges = edgeRows.map((row) => {
      const source = row.Source.trim();
      const target = row.Target.trim();
      const [a, b] = canonicalPair(source, target);
      return {
        id: JSON.stringify([a, b]),
        source,
        target,
        weight: Number(row.Weight)
      };
    });
    nodeById = new Map(nodes.map((node) => [node.id, node]));
    edgeByPair = new Map(edges.map((edge) => [
      canonicalPair(edge.source, edge.target).join("\u0000"),
      edge
    ]));
    edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    matrixCells = nodes.flatMap((row) => nodes.map((column) => {
      const edge = edgeByPair.get(canonicalPair(row.id, column.id).join("\u0000"));
      return {
        rowId: row.id,
        columnId: column.id,
        edgeId: edge ? edge.id : "",
        weight: edge ? edge.weight : null,
        state: row.id === column.id ? "diagonal" : edge ? "visible" : "empty"
      };
    }));
    focusedCell = edges.length
      ? { rowId: edges[0].source, columnId: edges[0].target }
      : { rowId: nodes[0].id, columnId: nodes[0].id };

    for (const edge of edges) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      source.degree += 1;
      target.degree += 1;
      source.strength += edge.weight;
      target.strength += edge.weight;
    }

    communityInfo = assignCommunities(nodes, edges);
    document.querySelector("#character-count").textContent = String(nodes.length);
    document.querySelector("#relationship-count").textContent = String(edges.length);
    const minWeight = d3.min(edges, (edge) => edge.weight);
    const maxWeight = d3.max(edges, (edge) => edge.weight);
    weightDomain = [minWeight, maxWeight];
    thresholdMaximum = maxWeight + 1;
    sqrtColorScale = d3.scaleLinear()
      .domain([Math.sqrt(minWeight), Math.sqrt(maxWeight)])
      .range([0.18, 0.95])
      .clamp(true);
    colorForWeight = (weight) => {
      if (weightDomain[0] === weightDomain[1]) return d3.interpolatePurples(0.75);
      return d3.interpolatePurples(sqrtColorScale(Math.sqrt(weight)));
    };
    document.querySelector("#weight-range").textContent = `${minWeight}–${maxWeight}`;
    weightInput.min = String(minWeight);
    weightInput.max = String(thresholdMaximum);
    weightInput.value = String(minWeight);
    weightInput.step = "1";
    numberInput.min = String(minWeight);
    numberInput.max = String(thresholdMaximum);
    numberInput.value = String(minWeight);
    numberInput.step = "1";
    document.querySelectorAll("[data-threshold]").forEach((button) => {
      const rawValue = button.dataset.threshold;
      const threshold = rawValue === "min" ? minWeight : Number(rawValue);
      button.dataset.threshold = String(Math.max(minWeight, Math.min(thresholdMaximum, threshold)));
    });
    setDataControlsDisabled(false);
    setThresholdControls(minWeight);
    bindInteractions();
    renderMatrix();
    renderAccessibleRelationships();
    renderSelectionSummary();
    renderDetails();
    renderWeightLegend();
    updateSelectionButtons();
  } catch (error) {
    console.error("Unable to load or validate the character network:", error);
    errorPanel.hidden = false;
    document.querySelector("#load-error-summary").textContent =
      "The network data could not be loaded. Check the local server and CSV files, then try again.";
    document.querySelector("#load-error-detail").textContent = error.message;
    summary.textContent = "Network data unavailable";
  }
}

function bindInteractions() {
  if (interactionsBound) return;
  interactionsBound = true;
  d3.select("#weight-filter").on("input", scheduleThresholdUpdate);
  numberInput.addEventListener("input", scheduleThresholdUpdate);
  numberInput.addEventListener("change", commitNumericThreshold);
  document.querySelectorAll("[data-threshold]").forEach((button) => {
    button.addEventListener("click", () => {
      setThreshold(button.dataset.threshold === "min" ? weightDomain[0] : Number(button.dataset.threshold));
    });
  });
  sortInput.addEventListener("change", () => {
    const anchor = captureViewportAnchor();
    renderMatrix({ preserveAnchor: anchor });
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setMatrixView(button.dataset.view));
  });
  searchInput.addEventListener("input", updateSearchSuggestions);
  searchInput.addEventListener("keydown", handleSearchKeydown);
  document.querySelector("#clear-query").addEventListener("click", clearSearchQuery);
  document.querySelector("#clear-selection").addEventListener("click", clearSelection);
  document.querySelector("#clear-selection-inline").addEventListener("click", clearSelection);
  document.querySelector("#reset-view").addEventListener("click", resetView);
  document.querySelector("#restore-all-relationships").addEventListener("click", () => setThreshold(weightDomain[0]));
  document.querySelector("#show-details").addEventListener("click", revealDetails);
  document.querySelector("#mobile-show-details").addEventListener("click", () => {
    if (detailPanel.classList.contains("is-open")) {
      setDetailsExpanded(false);
    } else {
      revealDetails();
    }
  });
  document.querySelector("#mobile-show-details").hidden = true;
  viewport.addEventListener("scroll", () => {
    closeTooltip();
    updateStickyAxes();
  }, { passive: true });
  document.addEventListener("pointerdown", (event) => {
    if (!searchContainer.contains(event.target)) closeSuggestions();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || searchInput.getAttribute("aria-expanded") === "true") return;
    if (selectedId || selectedPair) clearSelection();
  });
  resizeObserver = new ResizeObserver(() => {
    revealMobileDetailsPrompt();
    const width = viewport.clientWidth;
    if (width === observedViewportWidth) return;
    observedViewportWidth = width;
    const anchor = captureViewportAnchor();
    renderMatrix({ preserveAnchor: anchor, updateDetails: false });
  });
  resizeObserver.observe(viewport);
}

document.querySelector("#retry-load").addEventListener("click", loadNetwork);
loadNetwork();

function validateData(nodeRows, edgeRows) {
  const errors = [];
  const ids = new Set();
  const labels = new Set();

  for (const [index, row] of nodeRows.entries()) {
    const id = (row.Id || "").trim();
    const label = (row.Label || "").trim();
    if (!id || !label) errors.push(`Character row ${index + 2} is missing an ID or name.`);
    if (ids.has(id)) errors.push(`Duplicate character ID: ${id}`);
    if (labels.has(label)) errors.push(`Duplicate character name: ${label}`);
    ids.add(id);
    labels.add(label);
  }

  const pairs = new Set();
  for (const [index, row] of edgeRows.entries()) {
    const source = (row.Source || "").trim();
    const target = (row.Target || "").trim();
    const weight = Number(row.Weight);
    if (!ids.has(source)) errors.push(`Relationship row ${index + 2} references an unknown source: ${source}`);
    if (!ids.has(target)) errors.push(`Relationship row ${index + 2} references an unknown target: ${target}`);
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`Co-occurrence weight in relationship row ${index + 2} must be a positive number.`);
    }
    if (source === target) errors.push(`Relationship row ${index + 2} is a self-relationship: ${source}`);
    const pairId = canonicalPair(source, target).join("\u0000");
    if (pairs.has(pairId)) errors.push(`Duplicate undirected relationship: ${source} — ${target}`);
    pairs.add(pairId);
  }
  return errors;
}

function canonicalPair(a, b) {
  return compareStableText(a, b) <= 0 ? [a, b] : [b, a];
}

function compareStableText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assignCommunities(networkNodes, networkEdges) {
  const originalOrder = new Map(networkNodes.map((node, index) => [node.id, index]));
  let levelNodes = networkNodes.map((node) => ({ members: [node.id] }));
  let levelEdges = networkEdges.map((edge) => ({
    source: originalOrder.get(edge.source),
    target: originalOrder.get(edge.target),
    weight: edge.weight
  }));
  const random = seededRandom(LOUVAIN.seed);

  for (let level = 0; level < 12; level += 1) {
    const partition = optimizeLevel(levelNodes, levelEdges, LOUVAIN.resolution, random);
    const groups = new Map();
    partition.forEach((community, index) => {
      if (!groups.has(community)) groups.set(community, []);
      groups.get(community).push(index);
    });
    if (groups.size === levelNodes.length) break;

    const groupKeys = [...groups.keys()].sort((a, b) =>
      compareStableText(minimumMemberId(groups.get(a), levelNodes), minimumMemberId(groups.get(b), levelNodes))
    );
    const aggregateIndex = new Map(groupKeys.map((key, index) => [key, index]));
    const nextNodes = groupKeys.map((key) => ({
      members: groups.get(key).flatMap((index) => levelNodes[index].members)
    }));
    const aggregateWeights = new Map();
    for (const edge of levelEdges) {
      const sourceGroup = aggregateIndex.get(partition[edge.source]);
      const targetGroup = aggregateIndex.get(partition[edge.target]);
      const pair = sourceGroup <= targetGroup
        ? `${sourceGroup}\u0000${targetGroup}`
        : `${targetGroup}\u0000${sourceGroup}`;
      const existing = aggregateWeights.get(pair) || { source: sourceGroup, target: targetGroup, weight: 0 };
      existing.weight += edge.source === edge.target ? edge.weight / 2 : edge.weight;
      aggregateWeights.set(pair, existing);
    }
    levelNodes = nextNodes;
    levelEdges = [...aggregateWeights.values()].map((edge) => ({
      ...edge,
      weight: edge.source === edge.target ? edge.weight * 2 : edge.weight
    }));
  }

  const finalGroups = new Map();
  levelNodes.forEach((node, index) => {
    if (!finalGroups.has(index)) finalGroups.set(index, []);
    finalGroups.get(index).push(...node.members);
  });
  const orderedGroups = [...finalGroups.values()].map((members) => ({
    members,
    firstName: members.map((id) => nodeById.get(id).label).sort(compareStableText)[0]
  })).sort((a, b) =>
    d3.descending(a.members.length, b.members.length) || compareStableText(a.firstName, b.firstName)
  );

  orderedGroups.forEach((group, index) => {
    group.id = `community-${index + 1}`;
    group.members.forEach((id) => {
      nodeById.get(id).communityId = group.id;
    });
  });
  return orderedGroups;
}

function optimizeLevel(levelNodes, levelEdges, resolution, random) {
  const adjacency = levelNodes.map(() => new Map());
  for (const edge of levelEdges) {
    adjacency[edge.source].set(edge.target, (adjacency[edge.source].get(edge.target) || 0) + edge.weight);
    if (edge.source !== edge.target) {
      adjacency[edge.target].set(edge.source, (adjacency[edge.target].get(edge.source) || 0) + edge.weight);
    }
  }
  const degree = adjacency.map((neighbors) => [...neighbors.values()].reduce((sum, value) => sum + value, 0));
  const totalDegree = degree.reduce((sum, value) => sum + value, 0);
  const community = levelNodes.map((_, index) => index);
  const totals = [...degree];
  const stableKeys = levelNodes.map((node) => node.members.slice().sort()[0]);
  if (!totalDegree) return community;

  for (let pass = 0; pass < 100; pass += 1) {
    const order = d3.range(levelNodes.length);
    shuffle(order, random);
    let moved = false;
    for (const nodeIndex of order) {
      const oldCommunity = community[nodeIndex];
      const nodeDegree = degree[nodeIndex];
      totals[oldCommunity] -= nodeDegree;
      const weightsByCommunity = new Map();
      for (const [neighbor, weight] of adjacency[nodeIndex]) {
        if (neighbor === nodeIndex) continue;
        const neighborCommunity = community[neighbor];
        weightsByCommunity.set(neighborCommunity, (weightsByCommunity.get(neighborCommunity) || 0) + weight);
      }
      const candidates = [...weightsByCommunity.keys()];
      if (!candidates.includes(oldCommunity)) candidates.push(oldCommunity);
      let bestCommunity = oldCommunity;
      let bestGain = 0;
      for (const candidate of candidates) {
        const gain = (weightsByCommunity.get(candidate) || 0)
          - (resolution * totals[candidate] * nodeDegree) / totalDegree;
        const tied = Math.abs(gain - bestGain) < 1e-12;
        const stableTieWins = tied && candidate !== oldCommunity
          && bestCommunity !== oldCommunity
          && stableKeys[candidate] < stableKeys[bestCommunity];
        if (gain > bestGain + 1e-12 || stableTieWins) {
          bestGain = gain;
          bestCommunity = candidate;
        }
      }
      totals[bestCommunity] += nodeDegree;
      if (bestCommunity !== oldCommunity) {
        community[nodeIndex] = bestCommunity;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

function minimumMemberId(indices, levelNodes) {
  return indices.flatMap((index) => levelNodes[index].members).sort()[0];
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
}

function renderMatrix({ preserveAnchor = null, updateDetails = false } = {}) {
  closeTooltip();
  if (!nodes.length) return;

  const orderedNodes = getOrderedNodes();
  currentOrderedNodes = orderedNodes;
  currentIndexById = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const minimumWeight = Number(weightInput.value);
  const cellSize = currentCellSize;
  const innerSize = orderedNodes.length * cellSize;
  const width = MARGIN.left + innerSize + MARGIN.right;
  const height = MARGIN.top + innerSize + MARGIN.bottom;
  const availableWidth = viewport.clientWidth;
  const renderedWidth = cellSize <= 6 && availableWidth > 0 ? availableWidth : width;
  matrixScale = renderedWidth / width;
  for (const cell of matrixCells) {
    cell.state = cell.rowId === cell.columnId
      ? "diagonal"
      : !cell.edgeId ? "empty" : cell.weight < minimumWeight ? "filtered" : "visible";
  }

  const svg = matrixElement.selectAll("svg").data([null]).join("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", renderedWidth)
    .attr("height", height * matrixScale)
    .attr("role", "grid")
    .attr("aria-rowcount", orderedNodes.length)
    .attr("aria-colcount", orderedNodes.length)
    .attr("aria-describedby", "matrix-help")
    .attr("aria-label", `Character co-occurrence matrix for A Storm of Swords with ${orderedNodes.length} characters`);
  currentSvg = svg;

  svg.selectAll(".matrix-background").data([null]).join("rect")
    .attr("class", "matrix-background")
    .attr("x", MARGIN.left)
    .attr("y", MARGIN.top)
    .attr("width", innerSize)
    .attr("height", innerSize);

  const cellsByRow = d3.group(matrixCells, (cell) => cell.rowId);
  const rows = svg.selectAll(".matrix-row")
    .data(orderedNodes, (node) => node.id)
    .join((enter) => enter.append("g").attr("class", "matrix-row"))
    .attr("transform", (node) => `translate(0,${MARGIN.top + currentIndexById.get(node.id) * cellSize})`)
    .attr("role", "row")
    .attr("aria-rowindex", (node) => currentIndexById.get(node.id) + 1);
  rows.selectAll(".matrix-cell")
    .data((node) => cellsByRow.get(node.id), (cell) => cell.columnId)
    .join("rect")
    .attr("class", (cell) => `matrix-cell is-${cell.state}`)
    .attr("x", (cell) => MARGIN.left + currentIndexById.get(cell.columnId) * cellSize)
    .attr("y", 0)
    .attr("width", Math.max(1, cellSize - 0.7))
    .attr("height", Math.max(1, cellSize - 0.7))
    .attr("fill", (cell) => cell.state === "visible" ? colorForWeight(cell.weight) : null)
    .attr("data-row-id", (cell) => cell.rowId)
    .attr("data-column-id", (cell) => cell.columnId)
    .attr("data-edge-id", (cell) => cell.edgeId || null)
    .attr("data-weight", (cell) => cell.weight ?? null)
    .attr("role", "gridcell")
    .attr("aria-label", cellAriaLabel)
    .attr("aria-selected", (cell) => isSelectedPair(cell) ? "true" : "false")
    .attr("aria-colindex", (cell) => currentIndexById.get(cell.columnId) + 1)
    .attr("tabindex", (cell) => isFocusedCell(cell) ? 0 : -1)
    .on("pointerenter", (event, cell) => {
      hoveredCell = cell;
      updateHighlights(svg);
      if (cell.state !== "diagonal") showTooltip(event, cell);
    })
    .on("pointermove", (event, cell) => {
      if (cell.state !== "diagonal") showTooltip(event, cell);
    })
    .on("pointerleave pointercancel", () => {
      hoveredCell = null;
      closeTooltip();
      updateHighlights(svg);
    })
    .on("click", (event, cell) => {
      event.stopPropagation();
      selectPair(cell, { origin: "matrix" });
    })
    .on("focus", (_, cell) => {
      focusedCell = { rowId: cell.rowId, columnId: cell.columnId };
      updateHighlights(svg);
      announceCell(cell);
    })
    .on("keydown", handleMatrixKeydown);

  drawCommunityBands(svg, orderedNodes, innerSize, cellSize);
  drawAxes(svg, orderedNodes, innerSize, cellSize);
  updateHighlights(svg);
  updateStickyAxes();
  renderSummary(minimumWeight);
  renderEmptyState(minimumWeight);
  renderSelectionSummary();
  if (updateDetails) renderDetails();
  if (preserveAnchor) restoreViewportAnchor(preserveAnchor);
}

function getOrderedNodes() {
  const order = sortInput.value;
  return [...nodes].sort((a, b) => {
    if (order === "community") {
      const groupA = communityInfo.findIndex((group) => group.id === a.communityId);
      const groupB = communityInfo.findIndex((group) => group.id === b.communityId);
      return d3.ascending(groupA, groupB)
        || d3.descending(a.strength, b.strength)
        || d3.ascending(a.label, b.label);
    }
    if (order === "degree") return d3.descending(a.degree, b.degree) || d3.ascending(a.label, b.label);
    if (order === "strength") return d3.descending(a.strength, b.strength) || d3.ascending(a.label, b.label);
    return d3.ascending(a.label, b.label);
  });
}

function drawCommunityBands(svg, orderedNodes, innerSize, cellSize) {
  const showBoundaries = sortInput.value === "community";
  svg.selectAll(".community-boundary").remove();
  if (!showBoundaries) return;
  const boundaries = [];
  for (let index = 1; index < orderedNodes.length; index += 1) {
    if (orderedNodes[index].communityId !== orderedNodes[index - 1].communityId) {
      boundaries.push(index);
    }
  }
  svg.selectAll(".community-boundary")
    .data(boundaries)
    .join("path")
    .attr("class", "community-boundary")
    .attr("d", (index) => {
      const position = MARGIN.left + index * cellSize - 1;
      const yPosition = MARGIN.top + index * cellSize - 1;
      return `M${position},${MARGIN.top}V${MARGIN.top + innerSize}M${MARGIN.left},${yPosition}H${MARGIN.left + innerSize}`;
    });
}

function drawAxes(svg, orderedNodes, innerSize, cellSize) {
  const zoomed = cellSize > 6;
  const colors = communityColorScale();
  const rowAxis = svg.selectAll(".row-axis").data([null]).join("g").attr("class", "row-axis");
  rowAxis.selectAll(".axis-sticky-background").data([null]).join("rect")
    .attr("class", "axis-sticky-background")
    .attr("x", 0).attr("y", MARGIN.top - 1)
    .attr("width", MARGIN.left).attr("height", innerSize + 2);
  const rowIndex = new Map(orderedNodes.map((node, index) => [node.id, index]));
  rowAxis.selectAll(".row-community-band")
    .data(orderedNodes, (node) => node.id)
    .join("rect")
    .attr("class", "row-community-band")
    .attr("data-node-id", (node) => node.id)
    .attr("data-community", (node) => node.communityId)
    .attr("x", MARGIN.left - 9)
    .attr("y", (node) => MARGIN.top + rowIndex.get(node.id) * cellSize)
    .attr("width", 5)
    .attr("height", cellSize)
    .attr("fill", (node) => colors(node.communityId));
  const groupRuns = communityRuns(orderedNodes);
  rowAxis.selectAll(".community-anchor")
    .data(zoomed ? [] : groupRuns.filter((run) => run.count * cellSize * matrixScale >= 22))
    .join("text")
    .attr("class", "community-anchor")
    .attr("x", 8)
    .attr("y", (run) => MARGIN.top + (run.start + run.count / 2) * cellSize)
    .attr("font-size", `${Math.max(8, 9 / matrixScale)}px`)
    .text((run) => `C${run.communityNumber}`);
  rowAxis.selectAll(".axis-title").data([null]).join("text")
    .attr("class", "axis-title")
    .attr("x", 8).attr("y", MARGIN.top - 16)
    .text("Characters");
  rowAxis.selectAll(".row-label")
    .data(orderedNodes, (node) => node.id)
    .join("text")
    .attr("class", (node) => `axis-label row-label${zoomed || isSelectedNode(node.id) ? "" : " is-hidden"}`)
    .attr("data-node-id", (node) => node.id)
    .attr("data-community", (node) => node.communityId)
    .attr("x", MARGIN.left - 14)
    .attr("y", (_, index) => MARGIN.top + index * cellSize + cellSize / 2)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "middle")
    .attr("role", "button")
    .attr("tabindex", -1)
    .attr("aria-hidden", (node) => !zoomed && !isSelectedNode(node.id) ? "true" : null)
    .attr("aria-label", (node) => `View character ${node.label}`)
    .text((node) => node.label)
    .on("click", (_, node) => selectPerson(node.id, { origin: "axis" }));

  const columnAxis = svg.selectAll(".column-axis").data([null]).join("g").attr("class", "column-axis");
  columnAxis.selectAll(".axis-sticky-background").data([null]).join("rect")
    .attr("class", "axis-sticky-background")
    .attr("x", MARGIN.left - 1).attr("y", 0)
    .attr("width", innerSize + 2).attr("height", MARGIN.top);
  columnAxis.selectAll(".column-community-band")
    .data(orderedNodes, (node) => node.id)
    .join("rect")
    .attr("class", "column-community-band")
    .attr("data-node-id", (node) => node.id)
    .attr("data-community", (node) => node.communityId)
    .attr("x", (node) => MARGIN.left + rowIndex.get(node.id) * cellSize)
    .attr("y", MARGIN.top - 9)
    .attr("width", cellSize)
    .attr("height", 5)
    .attr("fill", (node) => colors(node.communityId));
  columnAxis.selectAll(".axis-title").data([null]).join("text")
    .attr("class", "axis-title")
    .attr("x", 8).attr("y", MARGIN.top - 16)
    .text(zoomed ? "Characters" : "Communities");
  columnAxis.selectAll(".column-label")
    .data(orderedNodes, (node) => node.id)
    .join("text")
    .attr("class", (node) => `axis-label column-label${zoomed || isSelectedNode(node.id) ? "" : " is-hidden"}`)
    .attr("data-node-id", (node) => node.id)
    .attr("data-community", (node) => node.communityId)
    .attr("transform", (_, index) =>
      `translate(${MARGIN.left + index * cellSize + cellSize / 2},${MARGIN.top - 15}) rotate(-55)`
    )
    .attr("text-anchor", "start")
    .attr("role", "button")
    .attr("tabindex", -1)
    .attr("aria-hidden", (node) => !zoomed && !isSelectedNode(node.id) ? "true" : null)
    .attr("aria-label", (node) => `View character ${node.label}`)
    .text((node) => node.label)
    .on("click", (_, node) => selectPerson(node.id, { origin: "axis" }));
}

function updateStickyAxes() {
  if (!currentSvg) return;
  currentMatrixTransform = `translate(${viewport.scrollLeft / matrixScale},${viewport.scrollTop / matrixScale})`;
  currentSvg.select(".row-axis").attr("transform", `translate(${viewport.scrollLeft / matrixScale},0)`);
  currentSvg.select(".column-axis").attr("transform", `translate(0,${viewport.scrollTop / matrixScale})`);
}

function communityRuns(orderedNodes) {
  const runs = [];
  orderedNodes.forEach((node, index) => {
    const last = runs[runs.length - 1];
    if (last && last.communityId === node.communityId) last.count += 1;
    else {
      const communityNumber = communityInfo.findIndex((group) => group.id === node.communityId) + 1;
      runs.push({ communityId: node.communityId, communityNumber, start: index, count: 1 });
    }
  });
  return runs;
}

function communityColorScale() {
  return (communityId) => {
    const index = communityInfo.findIndex((group) => group.id === communityId);
    if (index < CATEGORY_COLORS.length) return CATEGORY_COLORS[index];
    const hue = (index * 137.508 + 265) % 360;
    return d3.hsl(hue, 0.42, 0.56).formatHex();
  };
}

function isSelectedNode(id) {
  return id === selectedId
    || (selectedPair && (id === selectedPair.rowId || id === selectedPair.columnId))
    || (hoveredCell && (id === hoveredCell.rowId || id === hoveredCell.columnId));
}

function cellAriaLabel(cell) {
  const row = nodeById.get(cell.rowId);
  const column = nodeById.get(cell.columnId);
  if (cell.state === "diagonal") return `${row.label}: self-relationship not shown`;
  if (cell.state === "empty") return `${row.label} and ${column.label}: no record in the data`;
  if (cell.state === "filtered") return `${row.label} and ${column.label}: ${cell.weight} co-occurrences, below the current threshold`;
  return `${row.label} and ${column.label}: ${cell.weight} co-occurrences`;
}

function updateHighlights(svg) {
  const activeCell = hoveredCell;
  const activePerson = selectedId;
  const activePair = selectedPair;
  const activeRow = activeCell?.rowId
    || activePair?.rowId
    || activePerson
    || focusedCell?.rowId;
  const activeColumn = activeCell?.columnId
    || activePair?.columnId
    || activePerson
    || focusedCell?.columnId;
  svg.selectAll(".row-label, .column-label")
    .classed("is-active", (node) => node.id === activeRow || node.id === activeColumn)
    .classed("is-hidden", (node) => currentCellSize <= 6 && !(
      node.id === activePerson
      || (activePair && (node.id === activePair.rowId || node.id === activePair.columnId))
      || (activeCell && (node.id === activeCell.rowId || node.id === activeCell.columnId))
      || (focusedCell && (node.id === focusedCell.rowId || node.id === focusedCell.columnId))
    ));
  svg.selectAll(".matrix-cell")
    .classed("is-dimmed", (cell) => Boolean(
      activeCell?.edgeId && cell.edgeId && cell.state === "visible"
      && cell.edgeId !== activeCell.edgeId
      && cell.rowId !== activeCell.rowId && cell.columnId !== activeCell.rowId
      && cell.rowId !== activeCell.columnId && cell.columnId !== activeCell.columnId
    ))
    .classed("is-hovered-pair", (cell) => Boolean(activeCell && activeCell.edgeId
      && cell.edgeId === activeCell.edgeId && cell.state === "visible"))
    .classed("is-selected-pair", (cell) => Boolean(activePair && activePair.edgeId
      && cell.edgeId === activePair.edgeId))
    .classed("is-selected-person", (cell) => Boolean(activePerson
      && (cell.rowId === activePerson || cell.columnId === activePerson)))
    .classed("is-keyboard-focused", (cell) => isFocusedCell(cell))
    .attr("aria-selected", (cell) => isSelectedPair(cell) ? "true" : "false")
    .attr("tabindex", (cell) => isFocusedCell(cell) ? 0 : -1);
  const guideRow = activeRow && currentIndexById.get(activeRow);
  const guideColumn = activeColumn && currentIndexById.get(activeColumn);
  svg.selectAll(".interaction-guides").data([null]).join("g")
    .attr("class", "interaction-guides")
    .attr("pointer-events", "none")
    .call((guides) => {
      guides.selectAll(".row-guide").data(guideRow === undefined ? [] : [guideRow]).join("line")
        .attr("class", "row-guide")
        .attr("x1", MARGIN.left).attr("x2", MARGIN.left + currentOrderedNodes.length * currentCellSize)
        .attr("y1", (index) => MARGIN.top + index * currentCellSize + currentCellSize / 2)
        .attr("y2", (index) => MARGIN.top + index * currentCellSize + currentCellSize / 2);
      guides.selectAll(".column-guide").data(guideColumn === undefined ? [] : [guideColumn]).join("line")
        .attr("class", "column-guide")
        .attr("x1", (index) => MARGIN.left + index * currentCellSize + currentCellSize / 2)
        .attr("x2", (index) => MARGIN.left + index * currentCellSize + currentCellSize / 2)
        .attr("y1", MARGIN.top).attr("y2", MARGIN.top + currentOrderedNodes.length * currentCellSize);
    });
}

function renderSummary(minimumWeight) {
  const visibleCount = edges.filter((edge) => edge.weight >= minimumWeight).length;
  summary.textContent = `${visibleCount} / ${edges.length} relationships shown · ${nodes.length} characters`;
}

function showTooltip(event, cell) {
  const row = nodeById.get(cell.rowId);
  const column = nodeById.get(cell.columnId);
  const text = cell.state === "visible"
    ? `${row.label} ↔ ${column.label}\n${cell.weight} co-occurrences`
    : cell.state === "filtered"
      ? `${row.label} ↔ ${column.label}\n${cell.weight} co-occurrences · below current threshold`
      : `${row.label} ↔ ${column.label}\nNo record in the data`;
  tooltip.text(text).classed("visible", true);
  positionTooltip(event);
}

function closeTooltip() {
  tooltip.classed("visible", false).text("");
}

function positionTooltip(event) {
  if (!tooltip.classed("visible")) return;
  const bounds = viewport.getBoundingClientRect();
  const node = tooltip.node();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let x = event ? event.clientX - bounds.left + 12 : 12;
  let y = event ? event.clientY - bounds.top + 12 : 12;
  if (x + width > viewport.clientWidth - 8) x -= width + 24;
  if (y + height > viewport.clientHeight - 8) y -= height + 24;
  x = Math.max(8, Math.min(x, viewport.clientWidth - width - 8));
  y = Math.max(8, Math.min(y, viewport.clientHeight - height - 8));
  tooltip.style("left", `${x + viewport.scrollLeft}px`).style("top", `${y + viewport.scrollTop}px`);
}

function selectPerson(id, { origin = "search" } = {}) {
  const previousPair = selectedPair;
  selectedId = id;
  selectedPair = null;
  pairReturnPersonId = "";
  searchInput.value = nodeById.get(id).label;
  document.querySelector("#clear-query").hidden = false;
  searchMessage.textContent = "";
  closeSuggestions();
  renderMatrix({ updateDetails: true });
  renderAccessibleRelationships();
  renderSelectionSummary();
  updateSelectionButtons();
  if (origin !== "matrix") scrollToSelection();
  if (origin === "details") {
    const otherId = previousPair && (previousPair.rowId === id ? previousPair.columnId : previousPair.rowId);
    const neighbor = otherId && detailPanel.querySelector(`[data-focus-key="neighbor-${CSS.escape(otherId)}"]`);
    (neighbor || detailPanel.querySelector("h2"))?.focus({ preventScroll: true });
  }
  revealMobileDetailsPrompt();
  announce(`${nodeById.get(id).label} selected.`);
}

function selectPair(cell, { origin = "matrix", returnPersonId = "" } = {}) {
  selectedId = "";
  pairReturnPersonId = returnPersonId;
  if (origin !== "matrix") {
    searchInput.value = "";
    document.querySelector("#clear-query").hidden = true;
    searchMessage.textContent = "";
  }
  selectedPair = {
    rowId: cell.rowId,
    columnId: cell.columnId,
    edgeId: cell.edgeId,
    weight: cell.weight,
    state: cell.state
  };
  closeSuggestions();
  renderMatrix({ updateDetails: true });
  renderSelectionSummary();
  updateSelectionButtons();
  if (origin !== "matrix") scrollToSelection();
  if (origin === "details") detailPanel.querySelector(".detail-back")?.focus({ preventScroll: true });
  revealMobileDetailsPrompt();
  announce(`${nodeById.get(cell.rowId).label} and ${nodeById.get(cell.columnId).label} selected.`);
}

function scrollToSelection() {
  const rowId = selectedPair ? selectedPair.rowId : selectedId;
  const columnId = selectedPair ? selectedPair.columnId : selectedId;
  if (!rowId || !columnId || !currentIndexById.has(rowId) || !currentIndexById.has(columnId)) return;
  const rowIndex = currentIndexById.get(rowId);
  const columnIndex = currentIndexById.get(columnId);
  const cellLeft = (MARGIN.left + columnIndex * currentCellSize) * matrixScale;
  const cellTop = (MARGIN.top + rowIndex * currentCellSize) * matrixScale;
  const cellRight = cellLeft + currentCellSize * matrixScale;
  const cellBottom = cellTop + currentCellSize * matrixScale;
  const safeLeft = viewport.scrollLeft + MARGIN.left * matrixScale;
  const safeTop = viewport.scrollTop + MARGIN.top * matrixScale;
  const safeRight = viewport.scrollLeft + viewport.clientWidth;
  const safeBottom = viewport.scrollTop + viewport.clientHeight;
  if (cellLeft >= safeLeft && cellRight <= safeRight && cellTop >= safeTop && cellBottom <= safeBottom) return;
  const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTo({
    left: Math.max(0, Math.min(cellLeft - MARGIN.left * matrixScale - 18, maxLeft)),
    top: Math.max(0, Math.min(cellTop - MARGIN.top * matrixScale - 18, maxTop)),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}

function updateSearchSuggestions() {
  const query = searchInput.value.trim().toLowerCase();
  activeSuggestionIndex = -1;
  if (!query) {
    searchMessage.textContent = "";
    suggestions.replaceChildren();
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    document.querySelector("#clear-query").hidden = true;
    return;
  }
  document.querySelector("#clear-query").hidden = false;
  const candidates = nodes.filter((node) => node.label.toLowerCase().includes(query))
    .sort((a, b) => {
      const rank = (node) => {
        const label = node.label.toLowerCase();
        return label === query ? 0 : label.startsWith(query) ? 1 : 2;
      };
      return rank(a) - rank(b) || compareStableText(a.label, b.label);
    });
  const matches = candidates.slice(0, 8);
  if (!candidates.length) {
    searchMessage.textContent = "No matching characters; the current selection is unchanged.";
    suggestions.replaceChildren();
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }
  searchMessage.textContent = candidates.length > 1
    ? `${candidates.length} matches; showing the first ${matches.length}.` : "";
  suggestions.replaceChildren();
  suggestions.hidden = false;
  matches.forEach((node, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-option";
    button.id = `suggestion-${index}`;
    button.role = "option";
    button.tabIndex = -1;
    button.setAttribute("aria-selected", "false");
    button.textContent = node.label;
    button.addEventListener("click", () => {
      searchInput.focus();
      selectPerson(node.id, { origin: "search" });
    });
    suggestions.append(button);
  });
  searchInput.setAttribute("aria-expanded", "true");
}

function handleSearchKeydown(event) {
  const options = [...suggestions.querySelectorAll('[role="option"]')];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!options.length) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    activeSuggestionIndex = activeSuggestionIndex < 0
      ? (direction > 0 ? 0 : options.length - 1)
      : (activeSuggestionIndex + direction + options.length) % options.length;
    options.forEach((option, index) => {
      option.setAttribute("aria-selected", index === activeSuggestionIndex ? "true" : "false");
    });
    const active = options[activeSuggestionIndex];
    searchInput.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && activeSuggestionIndex >= 0 && options[activeSuggestionIndex]) {
    event.preventDefault();
    options[activeSuggestionIndex].click();
  } else if (event.key === "Escape" && searchInput.getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    event.stopPropagation();
    closeSuggestions();
  }
}

function clearSearchQuery() {
  searchInput.value = "";
  searchInput.focus();
  searchMessage.textContent = "";
  document.querySelector("#clear-query").hidden = true;
  closeSuggestions();
}

function closeSuggestions() {
  suggestions.replaceChildren();
  suggestions.hidden = true;
  activeSuggestionIndex = -1;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

function clearSelection() {
  selectedId = "";
  selectedPair = null;
  pairReturnPersonId = "";
  hoveredCell = null;
  focusedCell = edges.length ? { rowId: edges[0].source, columnId: edges[0].target } : focusedCell;
  tooltip.classed("visible", false);
  renderMatrix({ updateDetails: true });
  renderAccessibleRelationships();
  renderSelectionSummary();
  updateSelectionButtons();
  announce("Selection cleared.");
}

function resetView() {
  selectedId = "";
  selectedPair = null;
  pairReturnPersonId = "";
  hoveredCell = null;
  searchInput.value = "";
  searchMessage.textContent = "";
  document.querySelector("#clear-query").hidden = true;
  sortInput.value = "community";
  weightInput.value = String(weightDomain[0]);
  setMatrixViewButtons("overview");
  currentCellSize = 6;
  closeSuggestions();
  setThresholdControls(weightDomain[0]);
  renderMatrix({ updateDetails: true });
  renderAccessibleRelationships();
  renderSelectionSummary();
  updateSelectionButtons();
  setDetailsExpanded(false);
  viewport.scrollTo({ left: 0, top: 0, behavior: "auto" });
}

function scheduleThresholdUpdate() {
  if (pendingRenderFrame) cancelAnimationFrame(pendingRenderFrame);
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = 0;
    const input = document.activeElement === numberInput ? numberInput : weightInput;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    setThresholdControls(value);
    renderMatrix();
    updateThresholdDetails();
  });
}

function commitNumericThreshold() {
  const value = Number(numberInput.value);
  setThreshold(Number.isFinite(value) ? value : Number(weightInput.value));
  numberInput.value = weightInput.value;
}

function setThreshold(value) {
  setThresholdControls(value);
  renderMatrix();
  updateThresholdDetails();
}

function setThresholdControls(value) {
  const threshold = Math.max(weightDomain[0], Math.min(thresholdMaximum, Math.round(value)));
  weightInput.value = String(threshold);
  numberInput.value = String(threshold);
  document.querySelectorAll("[data-threshold]").forEach((button) => {
    const target = button.dataset.threshold === "min" ? weightDomain[0] : Number(button.dataset.threshold);
    button.classList.toggle("is-active", target === threshold);
    button.setAttribute("aria-pressed", target === threshold ? "true" : "false");
  });
}

function updateThresholdDetails() {
  renderSelectionSummary();
  updatePairVisibility();
  if (selectedId) {
    const visibleNeighbors = edges.filter((edge) =>
      edge.weight >= Number(weightInput.value) && (edge.source === selectedId || edge.target === selectedId)
    ).length;
    const metric = document.querySelector("#visible-connections-count");
    if (metric) metric.textContent = String(visibleNeighbors);
  }
  detailPanel.querySelectorAll("[data-edge-id]").forEach((element) => {
    const edge = edgeById.get(element.dataset.edgeId);
    if (!edge) return;
    const hidden = edge.weight < Number(weightInput.value);
    if (element.matches("button")) {
      const marker = [...detailPanel.querySelectorAll(".is-filtered[data-edge-id]")]
        .find((candidate) => candidate.dataset.edgeId === edge.id);
      if (hidden && !marker) {
        const note = document.createElement("span");
        note.className = "is-filtered";
        note.dataset.edgeId = edge.id;
        note.textContent = "(filtered out)";
        element.parentElement.append(note);
      } else if (!hidden && marker) marker.remove();
    }
  });
}

function updatePairVisibility() {
  if (!selectedPair?.edgeId) return;
  const hidden = selectedPair.weight < Number(weightInput.value);
  selectedPair.state = hidden ? "filtered" : "visible";
  const status = document.querySelector("#pair-visibility");
  const showPair = document.querySelector("#show-pair");
  if (status) {
    status.textContent = hidden
      ? "Below the current threshold; hidden from the matrix."
      : "This relationship is shown at the current threshold.";
    status.classList.toggle("is-filtered", hidden);
  }
  if (showPair) showPair.hidden = !hidden;
}

function setMatrixView(view) {
  const anchor = captureViewportAnchor();
  currentCellSize = view === "detail" ? 16 : 6;
  setMatrixViewButtons(view);
  renderMatrix({ preserveAnchor: anchor });
  if (selectedId || selectedPair) scrollToSelection();
}

function setMatrixViewButtons(view) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    if (button.matches(".view-segment button")) button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function captureViewportAnchor() {
  if (!currentOrderedNodes.length || !matrixScale) return null;
  const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / matrixScale;
  const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / matrixScale;
  const column = Math.max(0, Math.min(
    currentOrderedNodes.length - 1,
    Math.floor((centerX - MARGIN.left) / currentCellSize)
  ));
  const row = Math.max(0, Math.min(
    currentOrderedNodes.length - 1,
    Math.floor((centerY - MARGIN.top) / currentCellSize)
  ));
  return { rowId: currentOrderedNodes[row].id, columnId: currentOrderedNodes[column].id };
}

function restoreViewportAnchor(anchor) {
  if (!anchor || !currentIndexById.has(anchor.rowId) || !currentIndexById.has(anchor.columnId)) return;
  const x = (MARGIN.left + currentIndexById.get(anchor.columnId) * currentCellSize) * matrixScale;
  const y = (MARGIN.top + currentIndexById.get(anchor.rowId) * currentCellSize) * matrixScale;
  viewport.scrollTo({
    left: Math.max(0, x - viewport.clientWidth / 2),
    top: Math.max(0, y - viewport.clientHeight / 2),
    behavior: "auto"
  });
}

function setDetailsExpanded(expanded) {
  detailPanel.classList.toggle("is-open", expanded);
  const mobileButton = document.querySelector("#mobile-show-details");
  mobileButton.textContent = expanded ? "Hide details" : "View details";
  mobileButton.setAttribute("aria-expanded", expanded ? "true" : "false");
  document.querySelector("#show-details").setAttribute("aria-expanded", expanded ? "true" : "false");
}

function revealDetails() {
  setDetailsExpanded(true);
  detailPanel.focus({ preventScroll: true });
  if (window.matchMedia("(max-width: 760px)").matches) {
    detailPanel.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start"
    });
  }
}

function revealMobileDetailsPrompt() {
  document.querySelector("#mobile-show-details").hidden = !nodes.length
    || !window.matchMedia("(max-width: 760px)").matches;
}

function updateSelectionButtons() {
  const hasSelection = Boolean(selectedId || selectedPair);
  clearSelectionButton.disabled = !hasSelection;
  document.querySelector("#clear-selection-inline").disabled = !hasSelection;
  document.querySelector("#show-details").hidden = !hasSelection;
  document.querySelector("#clear-selection-inline").hidden = !hasSelection;
  revealMobileDetailsPrompt();
}

function renderSelectionSummary() {
  const hasSelection = Boolean(selectedId || selectedPair);
  selectionSummary.hidden = !hasSelection;
  if (!hasSelection) return;
  if (selectedId) {
    const person = nodeById.get(selectedId);
    selectionSummaryText.textContent = `Selected: ${person.label} · ${communityName(person.communityId)}`;
  } else {
    const first = nodeById.get(selectedPair.rowId);
    const second = nodeById.get(selectedPair.columnId);
    const filtered = selectedPair.edgeId && selectedPair.weight < Number(weightInput.value);
    selectionSummaryText.textContent = `Selected: ${first.label} ↔ ${second.label}${filtered ? " · filtered out" : ""}`;
  }
}

function renderEmptyState(minimumWeight) {
  const visibleCount = edges.filter((edge) => edge.weight >= minimumWeight).length;
  matrixEmptyState.hidden = visibleCount > 0;
}

function renderAccessibleRelationships() {
  accessibleRelationships.replaceChildren();
  const fragment = document.createDocumentFragment();
  edges.forEach((edge) => {
    const item = document.createElement("li");
    item.textContent = `${nodeById.get(edge.source).label} and ${nodeById.get(edge.target).label}: ${edge.weight} co-occurrences`;
    fragment.append(item);
  });
  accessibleRelationships.append(fragment);
}

function announce(message) {
  interactionStatus.textContent = "";
  requestAnimationFrame(() => { interactionStatus.textContent = message; });
}

function announceCell(cell) {
  const row = nodeById.get(cell.rowId);
  const column = nodeById.get(cell.columnId);
  interactionStatus.textContent = cell.edgeId
    ? `${row.label} and ${column.label}, ${cell.weight} co-occurrences.`
    : `${row.label} and ${column.label}, no record in the data.`;
}

function isFocusedCell(cell) {
  return Boolean(focusedCell && cell.rowId === focusedCell.rowId && cell.columnId === focusedCell.columnId);
}

function isSelectedPair(cell) {
  if (!selectedPair) return false;
  return selectedPair.edgeId
    ? cell.edgeId === selectedPair.edgeId
    : (cell.rowId === selectedPair.rowId && cell.columnId === selectedPair.columnId)
      || (cell.rowId === selectedPair.columnId && cell.columnId === selectedPair.rowId);
}

function handleMatrixKeydown(event, cell) {
  const directions = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  };
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    const rowIndex = currentIndexById.get(cell.rowId);
    const columnIndex = currentIndexById.get(cell.columnId);
    const nextRow = Math.max(0, Math.min(currentOrderedNodes.length - 1, rowIndex + direction[0]));
    const nextColumn = Math.max(0, Math.min(currentOrderedNodes.length - 1, columnIndex + direction[1]));
    focusedCell = { rowId: currentOrderedNodes[nextRow].id, columnId: currentOrderedNodes[nextColumn].id };
    const target = currentSvg.selectAll(".matrix-cell")
      .filter((candidate) => isFocusedCell(candidate))
      .node();
    target?.focus();
    if (!target) updateHighlights(currentSvg);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectPair(cell, { origin: "matrix" });
  } else if (event.key === "Escape") {
    event.preventDefault();
    clearSelection();
  }
}

function renderDetails() {
  const scrollTop = detailPanel.scrollTop;
  const focusKey = detailPanel.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey
    : null;
  detailPanel.replaceChildren();
  if (selectedPair) {
    renderPairDetails(selectedPair);
  } else if (selectedId) {
    renderPersonDetails(nodeById.get(selectedId));
  } else {
    appendText(detailPanel, "h2", "How to read");
    appendText(detailPanel, "p", "Rows and columns show the same set of characters; darker cells indicate more co-occurrences. Hover over or click a cell to inspect a pair.");
    const note = appendText(detailPanel, "p", "Communities are computed from the weighted network. They describe textual co-occurrence patterns—not families, alliances, or judgments about character relationships.");
    note.className = "community-note";
    const prompts = document.createElement("div");
    prompts.id = "exploration-prompts";
    prompts.className = "exploration-prompts";
    detailPanel.append(prompts);
    renderExplorationPrompts();
  }

  const communityHolder = document.createElement("div");
  communityHolder.className = "community-legend";
  if (selectedId || selectedPair) {
    const communityDetails = document.createElement("details");
    communityDetails.className = "community-details";
    communityDetails.innerHTML = "<summary>Communities</summary>";
    communityDetails.append(communityHolder);
    detailPanel.append(communityDetails);
  } else {
    detailPanel.append(communityHolder);
  }
  renderCommunityLegend(communityHolder);
  const methodology = document.createElement("details");
  methodology.className = "methodology";
  methodology.innerHTML = "<summary>Methodology</summary>";
  appendText(
    methodology,
    "p",
    `Communities are detected once on the full weighted network using ${LOUVAIN.name} modularity (resolution=${LOUVAIN.resolution}, seed=${LOUVAIN.seed}). Threshold changes do not affect community membership or the weight scale. A co-occurrence is based on character names appearing within 15 words in A Storm of Swords.`
  );
  detailPanel.append(methodology);
  detailPanel.scrollTop = scrollTop;
  if (focusKey) {
    const focusTarget = [...detailPanel.querySelectorAll("[data-focus-key]")]
      .find((element) => element.dataset.focusKey === focusKey);
    focusTarget?.focus({ preventScroll: true });
  }
}

function renderPairDetails(pair) {
  const row = nodeById.get(pair.rowId);
  const column = nodeById.get(pair.columnId);
  appendText(detailPanel, "p", "Character pair details", "detail-kicker");
  appendText(detailPanel, "h2", `${row.label} ↔ ${column.label}`).tabIndex = -1;
  if (pair.state === "diagonal") {
    appendText(detailPanel, "p", "The diagonal represents a character paired with themself; self-relationships are not shown.");
  } else if (!pair.edgeId) {
    appendText(detailPanel, "p", "No record in the data. Missing data does not mean these characters are unrelated.");
  } else {
    appendText(detailPanel, "p", `Co-occurrences in the full network: ${pair.weight}`);
    const status = appendText(
      detailPanel,
      "p",
      "",
      "status-note"
    );
    status.id = "pair-visibility";
    const showPair = appendText(detailPanel, "button", "Show this relationship", "action-button show-pair");
    showPair.type = "button";
    showPair.id = "show-pair";
    showPair.dataset.focusKey = "show-pair";
    showPair.addEventListener("click", () => setThreshold(pair.weight));
    updatePairVisibility();
  }
  appendText(detailPanel, "p", "Mirrored cells represent one undirected relationship and are counted once.", "detail-footnote");
  appendText(detailPanel, "p", `Algorithmic communities: ${communityName(row.communityId)} / ${communityName(column.communityId)}`, "detail-footnote");
  if (pairReturnPersonId) {
    const back = appendText(detailPanel, "button", `Back to ${nodeById.get(pairReturnPersonId).label}`, "text-action detail-back");
    back.type = "button";
    back.dataset.focusKey = `back-${pairReturnPersonId}`;
    back.addEventListener("click", () => selectPerson(pairReturnPersonId, { origin: "details" }));
  }
  for (const personId of [pair.rowId, pair.columnId]) {
    const personButton = appendText(detailPanel, "button", `View ${nodeById.get(personId).label}`, "text-action detail-person");
    personButton.type = "button";
    personButton.dataset.focusKey = `person-${personId}`;
    personButton.addEventListener("click", () => selectPerson(personId, { origin: "details" }));
  }
}

function renderPersonDetails(person) {
  appendText(detailPanel, "p", "Character details", "detail-kicker");
  appendText(detailPanel, "h2", person.label).tabIndex = -1;
  const visibleNeighbors = edges.filter((edge) =>
    edge.weight >= Number(weightInput.value) && (edge.source === person.id || edge.target === person.id)
  ).length;
  const metrics = document.createElement("dl");
  metrics.className = "person-metrics";
  const metricItems = [
    ["Community", communityName(person.communityId)],
    ["Connections", String(person.degree)],
    ["Total co-occurrences", String(person.strength)],
    ["Visible connections", String(visibleNeighbors)]
  ];
  metricItems.forEach(([label, value], index) => {
    const term = appendText(metrics, "dt", label);
    const description = appendText(metrics, "dd", value);
    if (index === 3) description.id = "visible-connections-count";
  });
  detailPanel.append(metrics);
  appendText(detailPanel, "h3", "Top 5 co-occurring characters in the full network");
  const neighbors = edges.filter((edge) => edge.source === person.id || edge.target === person.id)
    .map((edge) => ({
      edge,
      other: nodeById.get(edge.source === person.id ? edge.target : edge.source)
    }))
    .sort((a, b) => d3.descending(a.edge.weight, b.edge.weight) || d3.ascending(a.other.label, b.other.label))
    .slice(0, 5);
  const list = document.createElement("ol");
  list.className = "neighbor-list";
  for (const { edge, other } of neighbors) {
    const item = document.createElement("li");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "text-action";
    link.textContent = `${other.label} · ${edge.weight} co-occurrences`;
    link.dataset.edgeId = edge.id;
    link.dataset.focusKey = `neighbor-${other.id}`;
    link.addEventListener("click", () => selectPair({
      rowId: person.id,
      columnId: other.id,
      edgeId: edge.id,
      weight: edge.weight,
      state: edge.weight < Number(weightInput.value) ? "filtered" : "visible"
    }, { origin: "details", returnPersonId: person.id }));
    item.append(link);
    if (edge.weight < Number(weightInput.value)) {
      const hidden = document.createElement("span");
      hidden.className = "is-filtered";
      hidden.dataset.edgeId = edge.id;
      hidden.textContent = "(filtered out)";
      item.append(hidden);
    }
    list.append(item);
  }
  detailPanel.append(list);
  appendText(detailPanel, "p", "Ranked using the full network; relationships marked “filtered out” are below the current threshold.", "detail-footnote");
}

function renderCommunityLegend(holder = detailPanel.querySelector(".community-legend")) {
  if (!holder) return;
  holder.replaceChildren();
  appendText(holder, "h3", `Co-occurrence communities · ${communityInfo.length}`);
  const color = communityColorScale();
  const list = document.createElement("ul");
  list.className = "community-list";
  communityInfo.forEach((group) => {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "community-swatch";
    swatch.style.backgroundColor = color(group.id);
    const members = group.members.map((id) => nodeById.get(id));
    const notable = members.slice().sort((a, b) =>
      d3.descending(a.strength, b.strength) || d3.ascending(a.label, b.label)
    ).slice(0, 3).map((node) => node.label).join(", ");
    const label = document.createElement("span");
    label.textContent = `${communityName(group.id)} · ${group.members.length} characters`;
    const number = document.createElement("strong");
    number.className = "community-number";
    number.textContent = `C${communityInfo.indexOf(group) + 1}`;
    const names = document.createElement("small");
    names.textContent = notable;
    item.append(number, swatch, label, names);
    list.append(item);
  });
  holder.append(list);
}

function renderExplorationPrompts() {
  const holder = document.querySelector("#exploration-prompts");
  if (!holder || !edges.length) return;
  holder.replaceChildren();
  appendText(holder, "h3", "Explore the network");
  const mostConnected = nodes.slice().sort((a, b) =>
    d3.descending(a.degree, b.degree) || d3.ascending(a.label, b.label)
  )[0];
  const rankedEdges = edges.slice().sort((a, b) =>
    d3.descending(a.weight, b.weight)
    || d3.ascending(nodeById.get(a.source).label, nodeById.get(b.source).label)
    || d3.ascending(nodeById.get(a.target).label, nodeById.get(b.target).label)
  );
  const prompts = [
    {
      label: `Most connections: ${mostConnected.label} · ${mostConnected.degree} neighbors`,
      activate: () => selectPerson(mostConnected.id, { origin: "exploration" })
    },
    ...rankedEdges.slice(0, 2).map((edge, index) => ({
      label: `${index ? "Second-highest" : "Highest"} co-occurrence: ${nodeById.get(edge.source).label} ↔ ${nodeById.get(edge.target).label} · ${edge.weight}`,
      activate: () => selectPair({
        rowId: edge.source,
        columnId: edge.target,
        edgeId: edge.id,
        weight: edge.weight,
        state: edge.weight < Number(weightInput.value) ? "filtered" : "visible"
      }, { origin: "exploration" })
    }))
  ];
  for (const prompt of prompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "exploration-action";
    button.textContent = prompt.label;
    button.addEventListener("click", prompt.activate);
    holder.append(button);
  }
  appendText(holder, "p", "The highest co-occurrence count does not mean the relationship is the friendliest or most important.", "detail-footnote");
}

function renderWeightLegend() {
  const holder = d3.select("#weight-legend");
  holder.selectAll("*").remove();
  if (!edges.length) return;
  const width = 280;
  const height = 54;
  const barY = 5;
  const barHeight = 11;
  const svg = holder.append("svg")
    .attr("class", "legend-svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", "Square-root color scale across the full network weight range");
  const segments = 140;
  svg.selectAll(".legend-segment")
    .data(d3.range(segments))
    .join("rect")
    .attr("class", "legend-segment")
    .attr("x", (index) => index * width / segments)
    .attr("y", barY)
    .attr("width", width / segments + 0.5)
    .attr("height", barHeight)
    .attr("fill", (index) => {
      const t = index / (segments - 1);
      const weight = Math.pow(
        Math.sqrt(weightDomain[0]) + t * (Math.sqrt(weightDomain[1]) - Math.sqrt(weightDomain[0])),
        2
      );
      return colorForWeight(weight);
    });
  const ticks = [...new Set([
    weightDomain[0],
    ...[10, 25, 50].filter((value) => value > weightDomain[0] && value < weightDomain[1]),
    weightDomain[1]
  ])].sort((a, b) => a - b);
  svg.selectAll(".legend-tick")
    .data(ticks)
    .join("g")
    .attr("class", "legend-tick")
    .attr("transform", (value) => {
      const t = weightDomain[1] === weightDomain[0] ? 0.5
        : (Math.sqrt(value) - Math.sqrt(weightDomain[0]))
          / (Math.sqrt(weightDomain[1]) - Math.sqrt(weightDomain[0]));
      return `translate(${t * width},0)`;
    })
    .call((tick) => {
      tick.append("path").attr("d", `M0,${barY + barHeight}V${barY + barHeight + 4}`);
      tick.append("text")
        .attr("y", height - 2)
        .attr("text-anchor", (value) => value === weightDomain[0] ? "start"
          : value === weightDomain[1] ? "end" : "middle")
        .text((value) => value);
    });
}

function appendText(parent, tagName, text, className = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function communityName(id) {
  const index = communityInfo.findIndex((group) => group.id === id);
  return index < 0 ? "Unassigned community" : `Community ${index + 1}`;
}
