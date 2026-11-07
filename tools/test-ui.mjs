import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];
const errors = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
page.on("pageerror", (error) => {
  if (!/isExternalMethodAvailable/.test(error.message)) errors.push("pageerror: " + error.message);
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push("console: " + message.text());
});

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);

// A fresh web host database shows the first-run account gate. Continue as a guest so the rest of
// the UI suite exercises the same guest mode the static preview uses.
const accountGate = page.locator(".mn-onboard-overlay");
if (await accountGate.count()) {
  const continueLocally = accountGate.locator('[data-role="continue-local"]');
  if (await continueLocally.count()) {
    await continueLocally.click();
    await page.waitForTimeout(300);
  }
}

const byId = (id) => page.locator(`.mn-card[data-id="${id}"]`);
const cardIds = async () => page.locator(".mn-card").evaluateAll((els) => els.map((el) => el.dataset.id));
const selectedId = () => page.locator(".mn-card.is-selected").first().getAttribute("data-id");
const emptyPoint = async (dx = 0, dy = 0) => {
  const viewport = await page.locator("#viewport").boundingBox();
  return { x: viewport.x + viewport.width - 130 + dx, y: viewport.y + viewport.height - 140 + dy };
};
async function dragKanbanGrip(fromLocator, x, y) {
  const grip = await fromLocator.locator(".mn-kanban-grip").first().boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------- boot
check("app shell visible", await page.locator("#app").isVisible());
const fontsLoaded = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('12px "Plus Jakarta Sans"') && document.fonts.check('12px "Space Mono"');
});
check("Google fonts are vendored and load locally", fontsLoaded);
const railToolKeys = await page
  .locator(".mn-tool[data-tool]")
  .evaluateAll((els) => els.map((el) => el.dataset.tool));
check(
  "tool rail hides the temporarily disabled tools",
  railToolKeys.length === 16,
  String(railToolKeys.length)
);
check(
  "Map, Video and Audio are not offered by the rail",
  !railToolKeys.includes("map") && !railToolKeys.includes("video") && !railToolKeys.includes("audio"),
  railToolKeys.join(",")
);
check("tool rail keeps the trash button", (await page.locator(".mn-tool.mn-trash").count()) === 1);
const welcomeTypes = await page.evaluate(() =>
  Array.from(new Set(Array.from(document.querySelectorAll(".mn-card")).map((card) => card.dataset.type)))
);
const expectedWelcomeTypes = [
  "heading",
  "note",
  "todo",
  "link",
  "color",
  "comment",
  "column",
  "document",
  "table",
  "sketch",
  "image",
  "file",
  "board",
  "kanban",
];
check(
  "Welcome template shows every enabled card type",
  expectedWelcomeTypes.every((type) => welcomeTypes.includes(type)),
  welcomeTypes.join(", ")
);
check(
  "Temporarily disabled card types are absent from the welcome template",
  !welcomeTypes.includes("video") && !welcomeTypes.includes("audio") && !welcomeTypes.includes("map"),
  welcomeTypes.join(", ")
);
const hiddenCardId = await page.evaluate(async () => {
  const actions = await import("/js/actions.js");
  return actions.addCardAtCenter("audio").id;
});
await page.waitForTimeout(300);
check(
  "A temporarily disabled card added through the action layer stays hidden",
  (await page.locator(`.mn-card[data-id="${hiddenCardId}"]`).count()) === 0
);
await page.evaluate(async (id) => {
  const actions = await import("/js/actions.js");
  const store = await import("/js/store.js");
  actions.deleteCards([id], { trash: false });
  store.clearSelection();
}, hiddenCardId);
check("Welcome template includes line connections", (await page.locator(".mn-connection").count()) >= 2);
check("Welcome template has a nested board card", (await page.locator('.mn-card[data-type="board"] .mn-board-card').count()) >= 1);
check("column children are visible", (await page.locator(".mn-card.is-child").count()) === 2);
const firstColumnCard = page.locator(".mn-card-column").first();
const firstColumnBox = await firstColumnCard.boundingBox();
await page.mouse.click(firstColumnBox.x + firstColumnBox.width / 2, firstColumnBox.y + 30);
await page.waitForTimeout(300);
const columnStacking = await firstColumnCard.evaluate((el) => {
  const columnZ = Number(getComputedStyle(el).zIndex);
  const childZ = Array.from(document.querySelectorAll(".mn-card.is-child")).map((child) =>
    Number(getComputedStyle(child).zIndex)
  );
  return { columnZ, childZ };
});
check(
  "Clicking a column keeps its child cards above it",
  columnStacking.childZ.every((z) => z > columnStacking.columnZ),
  `${columnStacking.columnZ} / ${columnStacking.childZ.join(",")}`
);
check(
  "Column child cards hide their resize grip",
  (await page
    .locator(".mn-card.is-child [data-role='resize']")
    .first()
    .evaluate((el) => getComputedStyle(el).display)) === "none"
);
check("breadcrumb shows current board", (await page.locator(".mn-crumb.is-current").innerText()).toLowerCase().includes("home"));
const connectionsBeforeLine = await page.locator(".mn-connection").count();
check(
  "Connection endpoints stay hidden until the line is selected",
  (await page.locator(".mn-line-handle").count()) === 0
);
await page.click('.mn-tool[data-tool="line"]');
await page.waitForTimeout(250);
const lineFromBox = await page.locator(".mn-card-heading").first().boundingBox();
const lineToBox = await page.locator(".mn-card-color").first().boundingBox();
await page.mouse.move(lineFromBox.x + lineFromBox.width / 2, lineFromBox.y + lineFromBox.height / 2);
await page.mouse.down();
await page.mouse.move(lineToBox.x + lineToBox.width / 2, lineToBox.y + lineToBox.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
const connectionPaths = page.locator(".mn-connection");
const lastConnectionBox = await connectionPaths.last().boundingBox();
const lastPathData = await connectionPaths.last().getAttribute("d");
check(
  "Line tool draws a straight connector between cards",
  (await connectionPaths.count()) === connectionsBeforeLine + 1 &&
    Boolean(lastConnectionBox) &&
    lastConnectionBox.width + lastConnectionBox.height > 10 &&
    !lastPathData.includes("Q"),
  lastConnectionBox ? `${Math.round(lastConnectionBox.width)}x${Math.round(lastConnectionBox.height)}` : "no path"
);
check("Selected line shows endpoint and midpoint handles", (await page.locator(".mn-line-handle").count()) >= 3);
const midHandle = page.locator(".mn-line-mid");
const midBox = await midHandle.boundingBox();
await page.mouse.move(midBox.x + midBox.width / 2, midBox.y + midBox.height / 2);
await page.mouse.down();
await page.mouse.move(midBox.x + midBox.width / 2, midBox.y - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
check("Line can be curved manually", (await connectionPaths.last().getAttribute("d")).includes("Q"));
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
check("Selected line can be deleted", (await connectionPaths.count()) === connectionsBeforeLine);

// ---------------------------------------------------------------- board-level card trash
await page.click('.mn-tool[data-tool="note"]');
await page.waitForTimeout(300);
const trashedCardId = await selectedId();
await page.click(".mn-trash");
await page.waitForTimeout(400);
check("Deleting a card moves it to the board trash", (await byId(trashedCardId).count()) === 0);
await page.click(".mn-trash");
await page.waitForTimeout(400);
check(
  "Trash tool opens the deleted-card list",
  (await page.locator(".mn-modal").isVisible()) &&
    (await page.locator(".mn-modal-title").innerText()).includes("Trash") &&
    (await page.locator(".mn-trash-row").count()) === 1
);
await page.locator(".mn-trash-row .mn-btn", { hasText: "Restore" }).click();
await page.waitForTimeout(500);
check("Deleted card can be restored", (await byId(trashedCardId).count()) === 1);
await byId(trashedCardId).click();
await page.click(".mn-trash");
await page.waitForTimeout(400);
await page.click(".mn-trash");
await page.waitForTimeout(400);
await page.locator(".mn-modal .mn-btn", { hasText: "Empty trash" }).last().click();
await page.waitForTimeout(300);
await page.locator(".mn-modal .mn-btn", { hasText: "Empty trash" }).last().click();
await page.waitForTimeout(500);
check("Empty trash removes deleted cards permanently", (await byId(trashedCardId).count()) === 0);
const railBox = await page.locator('.mn-tool[data-tool="note"]').boundingBox();
const linkPopupPromise = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
await page.locator('.mn-card-link [data-action="open-link"]').first().click();
const linkPopup = await linkPopupPromise;
check(
  "Link card opens its URL in the browser",
  Boolean(linkPopup) && linkPopup.url().includes("example.com"),
  linkPopup ? linkPopup.url() : "no popup"
);
if (linkPopup) await linkPopup.close();
const noteToolButton = page.locator('.mn-tool[data-tool="note"]');
await noteToolButton.hover();
await page.waitForTimeout(150);
const toolTip = page.locator(".mn-tool-tip");
const toolTipShown = await toolTip.evaluate((el) => el.classList.contains("is-visible"));
const toolTipText = await toolTip.innerText();
const toolTipBox = await toolTip.boundingBox();
const noteToolBox = await noteToolButton.boundingBox();
check(
  "Tool tooltip appears instantly with a shortcut",
  toolTipShown && toolTipText.includes("Note") && toolTipText.includes("N"),
  toolTipText.replace(/\s+/g, " ")
);
check(
  "Tool tooltip opens to the right of the rail",
  Boolean(toolTipBox) && toolTipBox.x > noteToolBox.x + noteToolBox.width,
  toolTipBox ? `${Math.round(toolTipBox.x)} vs ${Math.round(noteToolBox.x + noteToolBox.width)}` : "no box"
);
await page.mouse.move(760, 620);
await page.waitForTimeout(220);
check(
  "Tool tooltip hides on leave",
  !(await toolTip.evaluate((el) => el.classList.contains("is-visible")))
);
const cardsBeforeShortcut = await page.locator(".mn-card").count();
await page.keyboard.press("n");
await page.waitForTimeout(350);
check("Tool shortcut creates a card", (await page.locator(".mn-card").count()) === cardsBeforeShortcut + 1);
await page.keyboard.press("Control+z");
await page.waitForTimeout(350);
check("Tool rail hover target is square", Math.abs(railBox.width - railBox.height) <= 2, `${Math.round(railBox.width)}x${Math.round(railBox.height)}`);

// ---------------------------------------------------------------- command palette and menu bar
const chromeOrder = await page.evaluate(() =>
  [...document.getElementById("app").children].slice(0, 2).map((el) => el.id || el.className)
);
check(
  "Menu bar sits above the file header and search lives in the menu bar",
  chromeOrder[0] === "menubar" &&
    chromeOrder[1] === "mn-topbar" &&
    (await page.locator("#command-search-btn").isVisible())
);
check(
  "Board access control is in the header right corner",
  (await page.locator("#share-btn").isVisible()) &&
    (await page.locator(".mn-topbar-right #share-btn").count()) === 1
);
const accountAfterShare = await page.evaluate(() => {
  const share = document.getElementById("share-btn");
  const account = document.getElementById("account-btn");
  return Boolean(
    share &&
      account &&
      share.parentElement === account.parentElement &&
      share.nextElementSibling === account
  );
});
check(
  "Account avatar button follows Share in the header",
  (await page.locator(".mn-topbar-right #account-btn").isVisible()) && accountAfterShare
);
const accountAvatar = await page.locator("#account-btn").evaluate((el) => {
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    radius: style.borderRadius,
    label: el.getAttribute("aria-label") || "",
    text: el.textContent.trim(),
  };
});
check(
  "Account avatar is a 30px round labelled button",
  accountAvatar.width === 30 &&
    accountAvatar.height === 30 &&
    (accountAvatar.radius === "50%" || Number.parseFloat(accountAvatar.radius) >= 15) &&
    accountAvatar.label.length > 0 &&
    accountAvatar.text.length > 0,
  JSON.stringify(accountAvatar)
);
await page.click("#account-btn");
await page.waitForTimeout(250);
check("Account center opens from the avatar", await page.locator(".mn-account-shell").isVisible());
const accountMenu = await page.locator(".mn-account-nav").innerText();
check(
  "Account center menu lists the account sections",
  ["Account Information", "Account Settings", "History Activity"].every((label) =>
    accountMenu.includes(label)
  )
);
check(
  "Guest account information offers a sign-in action",
  (await page.locator(".mn-account-pane").innerText()).toLowerCase().includes("sign in")
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Account center closes with Escape", (await page.locator(".mn-account-shell").count()) === 0);
const menuGroups = await page.locator(".mn-menubar-btn").allInnerTexts();
check(
  "Application menu bar has File, Edit, Tools, View and Help",
  ["File", "Edit", "Tools", "View", "Help"].every((group) => menuGroups.includes(group))
);
await page.locator(".mn-menubar-btn", { hasText: "File" }).click();
await page.waitForTimeout(250);
const fileMenuText = await page.locator(".mn-menu").innerText();
check(
  "File menu offers templates, export, import and backups",
  ["Template library", "Export board JSON", "Import board JSON", "Backup data", "Restore from backup"].every(
    (label) => fileMenuText.includes(label)
  ),
  fileMenuText.replace(/\s+/g, " ").slice(0, 140)
);
await page.keyboard.press("Escape");
await page.keyboard.press("Control+k");
await page.waitForTimeout(400);
const paletteGroups = await page.locator(".mn-palette-group").allInnerTexts();
check(
  "Command palette opens with grouped commands",
  (await page.locator(".mn-palette").isVisible()) &&
    (await page.locator(".mn-palette-item").count()) > 30 &&
    ["Tools", "File", "Edit", "View", "Help"].every((group) =>
      paletteGroups.some((label) => label.toLowerCase().includes(group.toLowerCase()))
    )
);
await page.fill(".mn-palette-input", "new note");
await page.waitForTimeout(250);
check(
  "Command palette filters tools and commands",
  (await page.locator(".mn-palette-item").allInnerTexts()).some((label) => label.includes("New note"))
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Command palette closes with Escape", (await page.locator(".mn-palette").count()) === 0);

// ---------------------------------------------------------------- design system states
await page.mouse.move(700, 500);
await page.waitForTimeout(120);
const menuButton = page.locator(".mn-menubar-btn").first();
const menuBackground = await menuButton.evaluate((el) => getComputedStyle(el).backgroundColor);
await menuButton.hover();
await page.waitForTimeout(180);
const menuHover = await menuButton.evaluate((el) => getComputedStyle(el).backgroundColor);
check("Menubar button changes background on hover", menuHover !== menuBackground);
await page.mouse.move(700, 500);
await page.keyboard.press("Tab");
await page.waitForTimeout(160);
const focusStyle = await page.evaluate(() => {
  const el = document.activeElement;
  const style = getComputedStyle(el);
  return { className: el?.className || "", outlineWidth: style.outlineWidth };
});
check(
  "Keyboard focus uses the Khaoyu accent ring",
  focusStyle.outlineWidth === "2px" && String(focusStyle.className).includes("mn-"),
  JSON.stringify(focusStyle)
);
const focusInput = page.locator(".mn-field-input").first();
if (await focusInput.count()) {
  await focusInput.click();
  await page.waitForTimeout(160);
  check(
    "Inputs show the Khaoyu focus glow",
    (await focusInput.evaluate((el) => getComputedStyle(el).boxShadow)) !== "none"
  );
}

// ---------------------------------------------------------------- add note + edit
const beforeAdd = (await cardIds()).length;
await page.click('.mn-tool[data-tool="note"]');
await page.waitForTimeout(250);
const noteId = await selectedId();
check("Note tool adds a card", (await cardIds()).length === beforeAdd + 1 && Boolean(noteId));

const note = byId(noteId);
const noteBox = await note.boundingBox();
const noteTextArea = await note.locator('[data-field="text"]').boundingBox();
check(
  "Note text is vertically centred",
  Math.abs(noteTextArea.y + noteTextArea.height / 2 - (noteBox.y + noteBox.height / 2)) < 8,
  `card=${Math.round(noteBox.height)} text centre offset=${Math.round(noteTextArea.y + noteTextArea.height / 2 - (noteBox.y + noteBox.height / 2))}`
);
await note.locator('[data-field="text"]').dblclick();
await page.keyboard.type("Hello from the test");
const away = await emptyPoint(-60, -60);
await page.mouse.click(away.x, away.y);
await page.waitForTimeout(350);
check("Double click edits note text", (await note.innerText()).includes("Hello from the test"), (await note.innerText()).slice(0, 40));

// ---------------------------------------------------------------- drag
const dragBefore = await note.boundingBox();
await page.mouse.move(dragBefore.x + 30, dragBefore.y + 12);
await page.mouse.down();
await page.mouse.move(dragBefore.x + 130, dragBefore.y + 62, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const dragAfter = await note.boundingBox();
check(
  "Card drag moves it",
  Math.abs(dragAfter.x - dragBefore.x - 100) < 14 && Math.abs(dragAfter.y - dragBefore.y - 50) < 14,
  `${Math.round(dragAfter.x - dragBefore.x)},${Math.round(dragAfter.y - dragBefore.y)}`
);

// ---------------------------------------------------------------- undo / redo
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
const undoBox = await note.boundingBox();
check("Undo restores position", Math.abs(undoBox.x - dragBefore.x) < 14);
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(300);
const redoBox = await note.boundingBox();
check("Redo re-applies move", Math.abs(redoBox.x - dragAfter.x) < 14);

// ---------------------------------------------------------------- horizontal resize
const sizeBefore = await note.boundingBox();
const handle = await note.locator(".mn-resize").boundingBox();
await page.mouse.move(handle.x + 3, handle.y + handle.height / 2);
await page.mouse.down();
await page.mouse.move(handle.x + 93, handle.y + handle.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const sizeAfter = await note.boundingBox();
check(
  "Resize is horizontal only",
  sizeAfter.width > sizeBefore.width + 50 && Math.abs(sizeAfter.height - sizeBefore.height) < 12,
  `${Math.round(sizeBefore.width)}x${Math.round(sizeBefore.height)} -> ${Math.round(sizeAfter.width)}x${Math.round(sizeAfter.height)}`
);
const grip = await note.locator(".mn-resize").boundingBox();
check(
  "Resize grip sits in the bottom-right corner",
  Math.abs(grip.x + grip.width - (sizeAfter.x + sizeAfter.width)) < 6 &&
    Math.abs(grip.y + grip.height - (sizeAfter.y + sizeAfter.height)) < 6,
  `${Math.round(grip.x)},${Math.round(grip.y)}`
);

// ---------------------------------------------------------------- todo flow
await page.click('.mn-tool[data-tool="todo"]');
await page.waitForTimeout(250);
const todoId = await selectedId();
const todo = byId(todoId);
const todoHeightBefore = (await todo.boundingBox()).height;
await todo.locator('[data-action="add-todo"]').click();
await page.waitForTimeout(200);
await page.keyboard.type("Buy milk");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Todo item text saved", (await todo.innerText()).includes("Buy milk"));
check(
  "Todo height grows with its first item",
  (await todo.boundingBox()).height > todoHeightBefore + 5,
  `${Math.round(todoHeightBefore)} -> ${Math.round((await todo.boundingBox()).height)}`
);
await todo.locator('[data-action="add-todo"]').click();
await page.waitForTimeout(200);
await page.keyboard.type("Call team");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const todoRows = todo.locator(".mn-todo-item");
const firstTodoBox = await todoRows.first().boundingBox();
const secondTodoGrip = await todoRows.nth(1).locator("[data-todo-grip]").boundingBox();
await page.mouse.move(
  secondTodoGrip.x + secondTodoGrip.width / 2,
  secondTodoGrip.y + secondTodoGrip.height / 2
);
await page.mouse.down();
await page.mouse.move(firstTodoBox.x + 40, firstTodoBox.y + 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const todoTexts = await todo
  .locator(".mn-todo-text")
  .evaluateAll((els) => els.map((el) => el.textContent.trim()));
check(
  "To-do items can be reordered with the burger handle",
  todoTexts[0] === "Call team" && todoTexts[1] === "Buy milk",
  todoTexts.join("|")
);
await todo.locator(".mn-check").last().check();
await page.waitForTimeout(200);
check("Todo checkbox marks done", await todo.locator(".mn-todo-item").last().evaluate((el) => el.classList.contains("is-done")));
const checkStyle = await todo.locator(".mn-check:checked").last().evaluate((el) => {
  const box = getComputedStyle(el);
  const mark = getComputedStyle(el, "::before");
  return { background: box.backgroundColor, markWidth: mark.width, markBorder: mark.borderLeftWidth };
});
check(
  "Done checkbox draws a check icon",
  checkStyle.background !== "rgba(0, 0, 0, 0)" && parseFloat(checkStyle.markWidth) > 0 && parseFloat(checkStyle.markBorder) > 0,
  JSON.stringify(checkStyle)
);

// ---------------------------------------------------------------- comment flow
await page.click('.mn-tool[data-tool="comment"]');
await page.waitForTimeout(250);
const commentId = await selectedId();
const comment = byId(commentId);
const commentHeightBefore = (await comment.boundingBox()).height;
await comment.locator('[data-field="comment-draft"]').fill("Looks good");
await comment.locator('[data-action="send-comment"]').click();
await page.waitForTimeout(300);
check("Comment send appends message", (await comment.innerText()).includes("Looks good"));
check(
  "Comment shows its upload time and date",
  /^\d{2}:\d{2}, \d{2}\/\d{2}\/\d{4}$/.test(await comment.locator(".mn-msg-time").last().innerText()),
  await comment.locator(".mn-msg-time").last().innerText()
);
const commentHeightAfter = (await comment.boundingBox()).height;
check(
  "Comment height grows automatically",
  commentHeightAfter > commentHeightBefore + 8,
  `${Math.round(commentHeightBefore)} -> ${Math.round(commentHeightAfter)}`
);
await comment.locator('[data-field="comment-draft"]').fill("Second message");
await comment.locator('[data-action="send-comment"]').click();
await page.waitForTimeout(300);
check(
  "Comment keeps growing with each message",
  (await comment.boundingBox()).height > commentHeightAfter + 8,
  `${Math.round(commentHeightAfter)} -> ${Math.round((await comment.boundingBox()).height)}`
);
check(
  "Comment rows have done checkboxes and a menu",
  (await comment.locator(".mn-msg-check").count()) === 2 && (await comment.locator(".mn-msg-menu").count()) === 2
);
const firstMessage = comment.locator(".mn-msg").first();
await firstMessage.locator(".mn-msg-check").check();
await page.waitForTimeout(250);
const doneDecoration = await firstMessage.locator(".mn-msg-text").evaluate((el) => getComputedStyle(el).textDecorationLine);
check(
  "Done comment is marked without strikethrough",
  (await firstMessage.evaluate((el) => el.classList.contains("is-done"))) && !doneDecoration.includes("line-through"),
  doneDecoration
);
const secondMessage = comment.locator(".mn-msg").last();
await secondMessage.hover();
await secondMessage.locator(".mn-msg-menu").click();
await page.waitForTimeout(300);
check("Comment menu opens", (await page.locator(".mn-menu").innerText()).includes("Delete comment"));
await page.locator(".mn-menu-item", { hasText: "Delete comment" }).click();
await page.waitForTimeout(350);
check("Comment can be deleted from its menu", (await comment.locator(".mn-msg").count()) === 1);

// ---------------------------------------------------------------- comments popup
await page.click("#comment-count");
await page.waitForTimeout(700);
check("Comments popup opens", await page.locator(".mn-comments-pop").isVisible());
check("Comments popup lists the message", (await page.locator(".mn-comments-pop").innerText()).includes("Looks good"));
check(
  "Comments popup shows the upload timestamp",
  /\d{2}:\d{2}, \d{2}\/\d{2}\/\d{4}/.test(await page.locator(".mn-comments-pop").innerText())
);
check("Comment badge shows message count", Number(await page.locator("#comment-count span").innerText()) >= 1);
await page.locator(".mn-comments-item").first().click();
await page.waitForTimeout(600);
check("Comment item navigates to its card", (await page.locator(".mn-card-comment.is-selected").count()) === 1);

// ---------------------------------------------------------------- notifications
const notifyBadge = page.locator("#notification-btn .mn-notify-badge");
check(
  "Notification badge shows unread comment activity",
  (await notifyBadge.isVisible()) && Number(await notifyBadge.innerText()) > 0
);
await page.click("#notification-btn");
await page.waitForTimeout(500);
check(
  "Notification panel lists notifications",
  (await page.locator(".mn-notify-pop").isVisible()) &&
    (await page.locator(".mn-notify-item").count()) > 0
);
const unreadBefore = await page.locator(".mn-notify-item.is-unread").count();
check("Notifications start unread", unreadBefore > 0, String(unreadBefore));
await page.locator('[data-notify="read-all"]').click();
await page.waitForTimeout(300);
check(
  "Mark all as read clears the unread state",
  (await page.locator(".mn-notify-item.is-unread").count()) === 0 && (await notifyBadge.isHidden())
);
await page.locator('[data-notify-action="read"]').first().click();
await page.waitForTimeout(300);
check("A notification can be marked unread again", (await page.locator(".mn-notify-item.is-unread").count()) === 1);
const notifyCountBeforeRemove = await page.locator(".mn-notify-item").count();
await page.locator('[data-notify-action="remove"]').first().click();
await page.waitForTimeout(300);
check(
  "A notification can be removed",
  (await page.locator(".mn-notify-item").count()) === notifyCountBeforeRemove - 1
);
await page.locator('[data-notify="delete-all"]').click();
await page.waitForTimeout(300);
check(
  "Delete all clears the notification list",
  (await page.locator(".mn-notify-item").count()) === 0 &&
    (await page.locator(".mn-notify-empty").isVisible()) &&
    (await notifyBadge.isHidden())
);
await page.locator(".mn-notify-close").click();
await page.waitForTimeout(250);

// ---------------------------------------------------------------- document popup
await page.click('.mn-tool[data-tool="document"]');
await page.waitForTimeout(500);
check("Document editor opens", await page.locator(".mn-doc-overlay").isVisible());
const docEditor = page.locator(".mn-doc-page");
await docEditor.click();
await page.keyboard.type("Markdown style document");
await page.keyboard.press("Control+b");
await page.keyboard.type(" bold text");
const insertButton = page.locator('.mn-doc-tool[title="Insert"]');
const insertBox = await insertButton.boundingBox();
await insertButton.click();
await page.waitForTimeout(250);
const insertMenuBox = await page.locator(".mn-doc-menu").boundingBox();
check(
  "Insert menu anchors to its toolbar button",
  Math.abs(insertMenuBox.x - (insertBox.x + insertBox.width + 8)) < 12 &&
    Math.abs(insertMenuBox.y - insertBox.y) < 12 &&
    insertMenuBox.x > 200,
  `menu ${Math.round(insertMenuBox.x)},${Math.round(insertMenuBox.y)} button ${Math.round(insertBox.x)},${Math.round(insertBox.y)}`
);
const exportButton = page.locator(".mn-doc-export");
const exportBox = await exportButton.boundingBox();
await exportButton.click();
await page.waitForTimeout(300);
const exportMenuBox = await page.locator(".mn-doc-menu").boundingBox();
check(
  "Export menu anchors to the Export button",
  Math.abs(exportMenuBox.x - (exportBox.x + exportBox.width + 8)) < 12 &&
    Math.abs(exportMenuBox.y - exportBox.y) < 12,
  `menu ${Math.round(exportMenuBox.x)},${Math.round(exportMenuBox.y)} button ${Math.round(exportBox.x)},${Math.round(exportBox.y)}`
);
await docEditor.click();
await page.waitForTimeout(200);
await page.locator(".mn-doc-close").click();
await page.waitForTimeout(400);
check("Document editor closes and saves", (await page.locator(".mn-doc-overlay").count()) === 0 && (await page.locator(".mn-card-document").last().innerText()).includes("Markdown style document"));
check("Document card preview is rich text", (await page.locator(".mn-card-document .mn-rich").last().innerHTML()).toLowerCase().includes("<b") || (await page.locator(".mn-card-document .mn-rich").last().innerHTML()).toLowerCase().includes("<strong"));

// ---------------------------------------------------------------- table edit
await page.click('.mn-tool[data-tool="table"]');
await page.waitForTimeout(250);
const tableId = await selectedId();
const table = byId(tableId);
check(
  "Active sheet shows spreadsheet column letters",
  (await table.locator(".mn-sheet-cols span").allInnerTexts()).join("") === "ABC"
);
check(
  "Active sheet shows spreadsheet row numbers",
  (await table.locator(".mn-sheet-rows span").allInnerTexts()).join("") === "123"
);
check(
  "Sheet keeps a visible thin scrollbar",
  (await table.locator(".mn-table").evaluate((el) => getComputedStyle(el).scrollbarWidth)) === "thin"
);
await table.locator("td").first().dblclick();
await page.keyboard.type("Row A");
const tableAway = await emptyPoint(-40, -70);
await page.mouse.click(tableAway.x, tableAway.y);
await page.waitForTimeout(300);
check("Table cell edit persists", (await table.locator("td").first().innerText()).includes("Row A"));
const tableRowsBefore = await table.locator("tr").count();
const tableColsBefore = await table.locator("tr").first().locator("td").count();
await table.hover();
const tableBox = await table.boundingBox();
const topAddBox = await table.locator(".mn-table-tools .mn-table-add").boundingBox();
check(
  "Table add button sits beside the top-left corner",
  topAddBox.y + topAddBox.height <= tableBox.y + 2 &&
    topAddBox.x > tableBox.x - 44 &&
    topAddBox.x < tableBox.x + 10,
  `button ${Math.round(topAddBox.x)},${Math.round(topAddBox.y)} card ${Math.round(tableBox.x)},${Math.round(tableBox.y)}`
);
check("Table has no separate side add button", (await table.locator(".mn-table-row-add").count()) === 0);
const inactiveGripPointer = await table
  .locator('[data-col-resize="0"]')
  .evaluate((el) => getComputedStyle(el).pointerEvents);
const inactiveColumnAddPointer = await table
  .locator("[data-sheet-add-column]")
  .evaluate((el) => getComputedStyle(el).pointerEvents);
const inactiveRowAddPointer = await table
  .locator("[data-sheet-add-row]")
  .evaluate((el) => getComputedStyle(el).pointerEvents);
check(
  "Sheet resize handles only activate while the sheet is focused",
  inactiveGripPointer === "none" &&
    inactiveColumnAddPointer === "none" &&
    inactiveRowAddPointer === "none",
  `${inactiveGripPointer}/${inactiveColumnAddPointer}/${inactiveRowAddPointer}`
);
await table.locator(".mn-table-tools .mn-table-add").click();
await page.waitForTimeout(250);
check("Table plus button opens the add menu", await table.locator(".mn-table-menu").isVisible());
await table.locator('.mn-table-menu [data-action="table-add-row"]').click();
await page.waitForTimeout(450);
check(
  "Table plus menu adds a row",
  (await table.locator("tr").count()) === tableRowsBefore + 1,
  `${tableRowsBefore} -> ${await table.locator("tr").count()}`
);
await table.hover();
await table.locator(".mn-table-tools .mn-table-add").click();
await table.locator('[data-action="table-add-column"]').click();
await page.waitForTimeout(450);
check(
  "Table plus menu adds a column",
  (await table.locator("tr").first().locator("td").count()) === tableColsBefore + 1,
  `${tableColsBefore} -> ${await table.locator("tr").first().locator("td").count()}`
);
await table.locator("td").first().click();
await page.waitForTimeout(300);
check(
  "Sheet headers follow the row and column counts",
  (await table.locator(".mn-sheet-cols span").allInnerTexts()).join("") === "ABCD" &&
    (await table.locator(".mn-sheet-rows span").allInnerTexts()).join("") === "1234"
);
const columnsBeforeHandle = await table.locator(".mn-sheet-cols > span").count();
const addColumnHandle = await table.locator("[data-sheet-add-column]").boundingBox();
await page.mouse.move(
  addColumnHandle.x + addColumnHandle.width / 2,
  addColumnHandle.y + addColumnHandle.height / 2
);
await page.mouse.down();
await page.mouse.move(addColumnHandle.x + 120, addColumnHandle.y + addColumnHandle.height / 2, {
  steps: 8,
});
await page.mouse.up();
await page.waitForTimeout(500);
const columnsAfterHandle = await table.locator(".mn-sheet-cols > span").count();
check(
  "Dragging the right handle adds a column",
  columnsAfterHandle === columnsBeforeHandle + 1 &&
    (await table.locator(".mn-sheet-cols > span").last().innerText()).startsWith("E"),
  `${columnsBeforeHandle} -> ${columnsAfterHandle}`
);
const rowsBeforeHandle = await table.locator(".mn-sheet-rows span").count();
const addRowHandle = await table.locator("[data-sheet-add-row]").boundingBox();
await page.mouse.move(
  addRowHandle.x + addRowHandle.width / 2,
  addRowHandle.y + addRowHandle.height / 2
);
await page.mouse.down();
await page.mouse.move(addRowHandle.x + addRowHandle.width / 2, addRowHandle.y + 32, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
const rowsAfterHandle = await table.locator(".mn-sheet-rows span").count();
check(
  "Dragging the bottom handle adds a row",
  rowsAfterHandle === rowsBeforeHandle + 1,
  `${rowsBeforeHandle} -> ${rowsAfterHandle}`
);
const sheetWidthBefore = (await table.boundingBox()).width;
const cornerResize = await table.locator('[data-role="resize"]').boundingBox();
await page.mouse.move(
  cornerResize.x + cornerResize.width / 2,
  cornerResize.y + cornerResize.height / 2
);
await page.mouse.down();
await page.mouse.move(cornerResize.x + 90, cornerResize.y + cornerResize.height / 2, {
  steps: 8,
});
await page.mouse.up();
await page.waitForTimeout(500);
check(
  "The corner resize grip resizes the sheet",
  (await table.boundingBox()).width > sheetWidthBefore + 40,
  `${Math.round(sheetWidthBefore)} -> ${Math.round((await table.boundingBox()).width)}`
);
const columnWidthsBefore = await table
  .locator(".mn-sheet-cols > span")
  .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
const firstColumnGrip = await table.locator('[data-col-resize="0"]').boundingBox();
const columnBoundary = await table.locator(".mn-sheet-cols > span").evaluateAll((els) => {
  const first = els[0].getBoundingClientRect();
  const second = els[1].getBoundingClientRect();
  return (first.right + second.left) / 2;
});
check(
  "Column resize grip sits on the header border",
  Math.abs(firstColumnGrip.x + firstColumnGrip.width / 2 - columnBoundary) < 3,
  `${Math.round(firstColumnGrip.x + firstColumnGrip.width / 2)} vs ${Math.round(columnBoundary)}`
);
await page.mouse.move(
  firstColumnGrip.x + firstColumnGrip.width / 2,
  firstColumnGrip.y + firstColumnGrip.height / 2
);
await page.mouse.down();
await page.mouse.move(firstColumnGrip.x + 80, firstColumnGrip.y + firstColumnGrip.height / 2, {
  steps: 8,
});
await page.mouse.up();
await page.waitForTimeout(400);
const columnWidthsAfter = await table
  .locator(".mn-sheet-cols > span")
  .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
check(
  "A single sheet column can be widened without changing the others",
  columnWidthsAfter[0] > columnWidthsBefore[0] + 30 &&
    Math.abs(columnWidthsAfter[1] - columnWidthsBefore[1]) < 6,
  `${Math.round(columnWidthsBefore[0])},${Math.round(columnWidthsBefore[1])} -> ${Math.round(
    columnWidthsAfter[0]
  )},${Math.round(columnWidthsAfter[1])}`
);
const columnsBeforeHandleDelete = await table.locator(".mn-sheet-cols > span").count();
const deleteColumnHandle = await table.locator("[data-sheet-add-column]").boundingBox();
await page.mouse.move(
  deleteColumnHandle.x + deleteColumnHandle.width / 2,
  deleteColumnHandle.y + deleteColumnHandle.height / 2
);
await page.mouse.down();
await page.mouse.move(
  deleteColumnHandle.x - 100,
  deleteColumnHandle.y + deleteColumnHandle.height / 2,
  { steps: 8 }
);
await page.mouse.up();
await page.waitForTimeout(500);
check(
  "Dragging the right handle left removes an empty column",
  (await table.locator(".mn-sheet-cols > span").count()) === columnsBeforeHandleDelete - 1,
  `${columnsBeforeHandleDelete} -> ${await table.locator(".mn-sheet-cols > span").count()}`
);
const rowsBeforeDelete = await table.locator(".mn-sheet-rows span").count();
await table.locator("tr").last().locator("td").first().dblclick();
await page.keyboard.type("Keep me");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const deleteRowHandle = await table.locator("[data-sheet-add-row]").boundingBox();
await page.mouse.move(
  deleteRowHandle.x + deleteRowHandle.width / 2,
  deleteRowHandle.y + deleteRowHandle.height / 2
);
await page.mouse.down();
await page.mouse.move(
  deleteRowHandle.x + deleteRowHandle.width / 2,
  deleteRowHandle.y - 42,
  { steps: 8 }
);
await page.mouse.up();
await page.waitForTimeout(500);
check(
  "Deleting a row with data asks for confirmation",
  (await page.locator(".mn-modal").isVisible()) &&
    (await page.locator(".mn-modal").innerText()).includes("contains data")
);
await page.locator(".mn-modal .mn-btn", { hasText: "Cancel" }).click();
await page.waitForTimeout(300);
check("Canceling the row delete keeps the row", (await table.locator(".mn-sheet-rows span").count()) === rowsBeforeDelete);
await page.mouse.move(
  deleteRowHandle.x + deleteRowHandle.width / 2,
  deleteRowHandle.y + deleteRowHandle.height / 2
);
await page.mouse.down();
await page.mouse.move(
  deleteRowHandle.x + deleteRowHandle.width / 2,
  deleteRowHandle.y - 42,
  { steps: 8 }
);
await page.mouse.up();
await page.waitForTimeout(500);
await page.locator(".mn-modal .mn-btn-primary").click();
await page.waitForTimeout(500);
check(
  "Confirming the delete removes the row with data",
  (await table.locator(".mn-sheet-rows span").count()) === rowsBeforeDelete - 1
);
// Remove the enlarged table so it cannot cover the cards used by the drag tests below.
await page.keyboard.press("Delete");
await page.waitForTimeout(450);
check("Table can be deleted after adding rows and columns", (await byId(tableId).count()) === 0);
await page.evaluate(() => {
  const viewport = document.getElementById("viewport");
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
  window.scrollTo(0, 0);
});

// table section ends here; color card codes
await page.click('.mn-tool[data-tool="color"]');
await page.waitForTimeout(350);
const colorCardId = await selectedId();
const colorCard = byId(colorCardId);
const colorText = (await colorCard.innerText()).replace(/\s+/g, " ");
check(
  "Color card shows HEX, RGB and CMYK",
  colorText.includes("HEX #") && colorText.includes("RGB ") && colorText.includes("CMYK "),
  colorText.slice(0, 90)
);
await colorCard.locator('[data-action="pick-color"]').click();
await page.waitForTimeout(350);
const colorPicker = page.locator(".mn-color-pop");
check(
  "Color picker opens with HSV controls and no title",
  (await colorPicker.isVisible()) &&
    (await colorPicker.locator(".mn-color-sv").count()) === 1 &&
    (await colorPicker.locator(".mn-color-hue").count()) === 1 &&
    (await colorPicker.locator(".mn-color-hex").count()) === 1 &&
    (await colorPicker.locator("[data-role='ok'], [data-role='cancel']").count()) === 0 &&
    !(await colorPicker.innerText()).toLowerCase().includes("box colour") &&
    !(await colorPicker.innerText()).toLowerCase().includes("box color")
);
const colorCardBox = await colorCard.boundingBox();
const colorPickerBox = await colorPicker.boundingBox();
check(
  "Color picker opens at the left of the card",
  colorPickerBox.x + colorPickerBox.width <= colorCardBox.x + 2,
  `picker ${Math.round(colorPickerBox.x + colorPickerBox.width)} card ${Math.round(colorCardBox.x)}`
);
await colorPicker.locator(".mn-color-hex").fill("#FF0000");
await colorPicker.locator(".mn-color-hex").press("Enter");
await page.waitForTimeout(400);
check(
  "Color picker applies the chosen hex",
  (await page.locator(".mn-color-pop").count()) === 0 &&
    (await colorCard.innerText()).includes("#FF0000")
);
const expectedColorName = await page.evaluate(async () => {
  const module = await import("/js/color-names.js");
  return module.colorNameForHex("#FF0000");
});
check(
  "Color card auto-fills the name from the color database",
  (await colorCard.locator(".mn-color-name").inputValue()) === expectedColorName &&
    Boolean(expectedColorName),
  expectedColorName
);
await colorCard.locator('[data-action="pick-color"]').click();
await page.waitForTimeout(300);
await page.locator(".mn-color-hex").fill("#00FF00");
await page.waitForTimeout(300);
check(
  "Color picker updates the card live",
  (await colorCard.innerText()).includes("#00FF00")
);
await page.mouse.click(6, 6);
await page.waitForTimeout(350);
check(
  "Color picker closes without reverting live changes",
  (await page.locator(".mn-color-pop").count()) === 0 &&
    (await colorCard.innerText()).includes("#00FF00")
);
await colorCard.locator('[data-action="pick-color"]').click();
await page.waitForTimeout(250);
await page.locator(".mn-color-hex").fill("#FF0000");
await page.locator(".mn-color-hex").press("Enter");
await page.waitForTimeout(300);
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: "http://127.0.0.1:1430",
});
const colorCodeRows = colorCard.locator(".mn-color-code-row");
check(
  "Color codes are stacked vertically",
  (await colorCodeRows.count()) === 3 &&
    (await colorCodeRows.nth(0).locator(".mn-color-code-label").innerText()) === "HEX" &&
    (await colorCodeRows.nth(1).locator(".mn-color-code-label").innerText()) === "RGB" &&
    (await colorCodeRows.nth(2).locator(".mn-color-code-label").innerText()) === "CMYK"
);
await colorCodeRows.first().hover();
await page.waitForTimeout(150);
check(
  "Color code copy button appears on hover",
  await colorCodeRows.first().locator(".mn-color-copy").isVisible()
);
await colorCodeRows.first().locator(".mn-color-copy").click();
await page.waitForTimeout(250);
const copiedColorCode = await page.evaluate(() => navigator.clipboard.readText());
check("Color code copy button copies the value", copiedColorCode === "#FF0000", copiedColorCode);
await page.keyboard.press("Delete");
await page.waitForTimeout(350);

// ---------------------------------------------------------------- kanban
await page.click('.mn-tool[data-tool="kanban"]');
await page.waitForTimeout(400);
const kanbanId = await selectedId();
const kanban = byId(kanbanId);
check("Kanban tool creates three columns", (await kanban.locator(".mn-kanban-col").count()) === 3);
const kanbanInitialWidth = await kanban.evaluate((el) => parseFloat(el.style.width) || 0);
check("Kanban starts at the full board content width", kanbanInitialWidth > 900, `${kanbanInitialWidth}px`);
const kanbanColumnWidths = await kanban
  .locator(".mn-kanban-col")
  .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
check(
  "Kanban columns stretch across the card",
  kanbanColumnWidths.every((width) => width > 200),
  kanbanColumnWidths.map((width) => Math.round(width)).join(",")
);
const kanbanMinHeight = await kanban.evaluate((el) => getComputedStyle(el).minHeight);
check("Kanban keeps a 500px minimum height", parseFloat(kanbanMinHeight) >= 500, kanbanMinHeight);
await kanban.locator('[data-action="kanban-add-column"]').click();
await page.waitForTimeout(450);
check("Kanban can add a column", (await kanban.locator(".mn-kanban-col").count()) === 4);
const kanbanWidthAfterAdd = await kanban.evaluate((el) => parseInt(el.style.width, 10) || 0);
check("Kanban auto-widens when a column is added", kanbanWidthAfterAdd >= 700, `${kanbanWidthAfterAdd}px`);
const firstKanbanColumn = kanban.locator(".mn-kanban-col").first();
await firstKanbanColumn.hover();
await firstKanbanColumn.locator('[data-action="kanban-add-item"]').click();
await page.waitForTimeout(450);
check("Kanban can add a card", (await firstKanbanColumn.locator(".mn-kanban-item").count()) === 1);
const kanbanItemInput = firstKanbanColumn.locator(".mn-kanban-item-input").first();
await kanbanItemInput.fill("Task A");
await kanbanItemInput.blur();
await page.waitForTimeout(250);
check("Kanban card text saved", (await kanbanItemInput.inputValue()) === "Task A");
await firstKanbanColumn.hover();
await firstKanbanColumn.locator('[data-action="kanban-add-item"]').click();
await page.waitForTimeout(400);
const secondKanbanInput = firstKanbanColumn.locator(".mn-kanban-item-input").nth(1);
await secondKanbanInput.fill("Task B");
await secondKanbanInput.blur();
await page.waitForTimeout(300);
const rowsBeforeReorder = firstKanbanColumn.locator(".mn-kanban-item");
const firstRowBox = await rowsBeforeReorder.first().boundingBox();
await dragKanbanGrip(rowsBeforeReorder.nth(1), firstRowBox.x + 40, firstRowBox.y + 2);
const reordered = await firstKanbanColumn
  .locator(".mn-kanban-item-input")
  .evaluateAll((els) => els.map((el) => el.value));
check(
  "Kanban card can be reordered inside its column",
  reordered.join("|") === "Task B|Task A",
  reordered.join("|")
);
const secondKanbanColumn = kanban.locator(".mn-kanban-col").nth(1);
const secondColumnBox = await secondKanbanColumn.boundingBox();
await dragKanbanGrip(
  firstKanbanColumn.locator(".mn-kanban-item").first(),
  secondColumnBox.x + secondColumnBox.width / 2,
  secondColumnBox.y + 50
);
check(
  "Kanban card drags to another column",
  (await secondKanbanColumn.locator(".mn-kanban-item").count()) === 1 &&
    (await firstKanbanColumn.locator(".mn-kanban-item").count()) === 1 &&
    (await secondKanbanColumn.locator(".mn-kanban-item-input").first().inputValue()) === "Task B"
);
await secondKanbanColumn.hover();
await secondKanbanColumn.locator('[data-action="kanban-remove-item"]').first().click();
await page.waitForTimeout(450);
check("Kanban can remove a card", (await secondKanbanColumn.locator(".mn-kanban-item").count()) === 0);
await firstKanbanColumn.hover();
await firstKanbanColumn.locator('[data-action="kanban-remove-column"]').click();
await page.waitForTimeout(450);
check("Kanban can remove a column", (await kanban.locator(".mn-kanban-col").count()) === 3);
await page.keyboard.press("Delete");
await page.waitForTimeout(450);
check("Kanban board can be deleted", (await byId(kanbanId).count()) === 0);

// Temporarily re-enable the disabled card types so the existing-card behaviour stays covered.
await page.evaluate(async () => {
  const limits = await import("/js/limits.js");
  window.__disabledToolsBackup = { ...limits.TEMPORARILY_DISABLED_TOOLS };
  for (const key of ["video", "audio", "map"]) delete limits.TEMPORARILY_DISABLED_TOOLS[key];
});

// ---------------------------------------------------------------- embedded media previews
// The video, map and audio tools are temporarily disabled, so these cards are created through the
// action layer to keep the existing-card behaviour covered.
const videoId = await page.evaluate(async () => {
  const actions = await import("/js/actions.js");
  return actions.addCardAtCenter("video").id;
});
await page.waitForTimeout(300);
const videoCard = byId(videoId);
const videoSubmit = await videoCard.locator(".mn-primary-soft").boundingBox();
check(
  "Video placeholder uses a compact full-width primary action",
  Boolean(videoSubmit) && videoSubmit.width > 150
);
const videoUrl = videoCard.locator('[data-field="url"]');
await videoUrl.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
await videoCard.locator(".mn-primary-soft").click();
await page.waitForTimeout(500);
check(
  "YouTube link starts behind a centered play overlay",
  (await videoCard.locator(".mn-video-play").isVisible()) &&
    (await videoCard.locator("iframe").count()) === 0 &&
    (await videoCard.boundingBox()).height >= 120
);
await videoCard.locator(".mn-video-play").click();
await page.waitForTimeout(600);
check(
  "Center play click loads the YouTube embed with autoplay",
  (await videoCard.locator("iframe").count()) === 1 &&
    (await videoCard.locator("iframe").getAttribute("src")).includes("youtube.com/embed/") &&
    (await videoCard.locator("iframe").getAttribute("src")).includes("autoplay=1")
);
check(
  "Playing video exposes pause, mute, seek, time and volume controls",
  (await videoCard.locator(".mn-video-controls").isVisible()) &&
    (await videoCard.locator('[data-action="video-toggle"]').count()) === 1 &&
    (await videoCard.locator('[data-action="video-mute"]').count()) === 1 &&
    (await videoCard.locator('[data-action="video-back5"]').count()) === 1 &&
    (await videoCard.locator('[data-action="video-forward5"]').count()) === 1 &&
    (await videoCard.locator("[data-video-seek]").count()) === 1 &&
    (await videoCard.locator("[data-video-time]").count()) === 1 &&
    (await videoCard.locator("[data-video-volume]").count()) === 1
);
await videoCard.locator("[data-video-volume]").fill("400");
await page.waitForTimeout(200);
check(
  "Video volume slider can be changed",
  (await videoCard.locator("[data-video-volume]").inputValue()) === "400"
);
check(
  "Video embed is sandboxed and sends a strict referrer policy",
  (await videoCard.locator("iframe").getAttribute("sandbox")).includes("allow-scripts") &&
    (await videoCard.locator("iframe").getAttribute("sandbox")).includes("allow-same-origin") &&
    (await videoCard.locator("iframe").getAttribute("referrerpolicy")) ===
      "strict-origin-when-cross-origin"
);
await videoCard.click({ button: "right" });
await page.waitForTimeout(250);
check(
  "Playing video disables Play and enables Pause",
  (await page.locator(".mn-menu-item", { hasText: "Play" }).getAttribute("disabled")) !== null &&
    (await page.locator(".mn-menu-item", { hasText: "Pause" }).getAttribute("disabled")) === null
);
await page.locator(".mn-menu-item", { hasText: "Pause" }).click();
await page.waitForTimeout(250);
await videoCard.click({ button: "right" });
await page.waitForTimeout(250);
check(
  "Paused video enables Play and disables Pause",
  (await page.locator(".mn-menu-item", { hasText: "Play" }).getAttribute("disabled")) === null &&
    (await page.locator(".mn-menu-item", { hasText: "Pause" }).getAttribute("disabled")) !== null
);
check(
  "Media context menu offers a native Repeat checkbox on the right",
  (await page.locator(".mn-menu-item", { hasText: /Repeat/ }).locator('input[type="checkbox"]').count()) === 1 &&
    !(await page.locator(".mn-menu-item", { hasText: /Repeat/ }).locator('input[type="checkbox"]').isChecked())
);
await page.locator(".mn-menu-item", { hasText: /Repeat/ }).click();
await page.waitForTimeout(350);
await videoCard.click({ button: "right" });
await page.waitForTimeout(250);
check(
  "Repeat toggles the native checkbox on",
  await page.locator(".mn-menu-item", { hasText: /Repeat/ }).locator('input[type="checkbox"]').isChecked()
);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check(
  "Loaded video iframe leaves the card draggable",
  (await videoCard.locator("iframe").evaluate((el) => getComputedStyle(el).pointerEvents)) === "none"
);
await videoCard.evaluate((el) => {
  window.__videoFrameBeforeDrag = el.querySelector("iframe");
});
const videoDragBefore = await videoCard.boundingBox();
await page.mouse.move(
  videoDragBefore.x + videoDragBefore.width / 2,
  videoDragBefore.y + videoDragBefore.height / 2
);
await page.mouse.down();
await page.mouse.move(
  videoDragBefore.x + videoDragBefore.width / 2 + 40,
  videoDragBefore.y + videoDragBefore.height / 2 - 20,
  { steps: 8 }
);
await page.mouse.up();
await page.waitForTimeout(400);
check(
  "Video card drags from inside the preview",
  (await videoCard.boundingBox()).x > videoDragBefore.x + 20
);
check(
  "Moving a video card keeps the same iframe instead of reloading",
  await videoCard.evaluate((el) => el.querySelector("iframe") === window.__videoFrameBeforeDrag)
);
await videoCard.hover();
await videoCard.locator(".mn-embed-edit").click();
await page.waitForTimeout(300);
check(
  "Video embed can be edited again",
  (await videoCard.locator('[data-field="url"]').inputValue()).includes("youtube.com/watch")
);
await page.keyboard.press("Escape");
await page.keyboard.press("Delete");
await page.waitForTimeout(300);

const mapId = await page.evaluate(async () => {
  const actions = await import("/js/actions.js");
  return actions.addCardAtCenter("map").id;
});
await page.waitForTimeout(300);
const mapCard = byId(mapId);
const mapQuery = mapCard.locator('[data-field="query"]');
await mapQuery.fill("https://www.google.com/maps/@40.758,-73.985,15z");
await mapCard.locator(".mn-primary-soft").click();
await page.waitForTimeout(500);
check(
  "Google Maps link renders a map preview",
  (await mapCard.locator("iframe").count()) === 1 &&
    (await mapCard.locator("iframe").getAttribute("src")).includes("maps.google.com/maps?q=40.758")
);
check(
  "Map embed is sandboxed",
  (await mapCard.locator("iframe").getAttribute("sandbox")).includes("allow-scripts") &&
    (await mapCard.locator("iframe").getAttribute("sandbox")).includes("allow-same-origin")
);
check(
  "Loaded map iframe leaves the card draggable",
  (await mapCard.locator("iframe").evaluate((el) => getComputedStyle(el).pointerEvents)) === "none"
);
await page.keyboard.press("Escape");
await page.keyboard.press("Delete");
await page.waitForTimeout(300);

const audioId = await page.evaluate(async () => {
  const actions = await import("/js/actions.js");
  return actions.addCardAtCenter("audio").id;
});
await page.waitForTimeout(300);
const audioCard = byId(audioId);
const audioBox = await audioCard.boundingBox();
const audioIcon = await audioCard.locator(".mn-audio-empty > svg").boundingBox();
const audioUpload = await audioCard.locator(".mn-audio-empty .mn-primary-soft").boundingBox();
const audioTopGap = audioIcon.y - audioBox.y;
const audioBottomGap = audioBox.y + audioBox.height - (audioUpload.y + audioUpload.height);
check(
  "Empty audio card keeps symmetric top and bottom padding",
  Math.abs(audioTopGap - audioBottomGap) < 6 &&
    Math.abs(audioUpload.x + audioUpload.width / 2 - (audioBox.x + audioBox.width / 2)) < 6,
  `top ${Math.round(audioTopGap)} bottom ${Math.round(audioBottomGap)}`
);
const audioUrl = audioCard.locator('[data-field="url"]');
await audioUrl.fill("https://example.com/sample.mp3");
await audioUrl.blur();
await page.waitForTimeout(500);
check(
  "Audio link renders an audio player",
  (await audioCard.locator("audio").count()) === 1 &&
    (await audioCard.locator("audio").getAttribute("src")).includes("sample.mp3")
);
const customAudio = await audioCard.evaluate((el) => ({
  native: el.querySelector("audio").hasAttribute("controls"),
  play: Boolean(el.querySelector(".mn-audio-play")),
  seek: Boolean(el.querySelector("[data-audio-seek]")),
  mute: Boolean(el.querySelector(".mn-audio-mute")),
}));
check(
  "Audio player uses custom themed controls",
  !customAudio.native && customAudio.play && customAudio.seek && customAudio.mute
);
await audioCard.locator('[data-action="edit-embed"]').click();
await page.waitForTimeout(300);
check(
  "Editing audio shows a clip-only upload button and Submit",
  (await audioCard.locator(".mn-audio-clip").isVisible()) &&
    (await audioCard.locator(".mn-audio-clip").innerText()).trim() === "" &&
    (await audioCard.locator('[data-action="submit-embed"]').isVisible())
);
const audioUrlBefore = await audioCard.locator('[data-field="url"]').inputValue();
await audioCard.locator(".mn-audio-clip").click();
const toneRate = 8000;
const toneSamples = 4000;
const tone = Buffer.alloc(44 + toneSamples * 2);
tone.write("RIFF", 0);
tone.writeUInt32LE(36 + toneSamples * 2, 4);
tone.write("WAVE", 8);
tone.write("fmt ", 12);
tone.writeUInt32LE(16, 16);
tone.writeUInt16LE(1, 20);
tone.writeUInt16LE(1, 22);
tone.writeUInt32LE(toneRate, 24);
tone.writeUInt32LE(toneRate * 2, 28);
tone.writeUInt16LE(2, 32);
tone.writeUInt16LE(16, 34);
tone.write("data", 36);
tone.writeUInt32LE(toneSamples * 2, 40);
await page.locator('input[type="file"]').setInputFiles({
  name: "replacement.wav",
  mimeType: "audio/wav",
  buffer: tone,
});
await page.waitForTimeout(600);
check(
  "Uploading while editing updates the audio source",
  (await audioCard.locator('[data-field="url"]').inputValue()) !== audioUrlBefore &&
    (await audioCard.locator(".mn-audio-clip").isVisible()) &&
    (await audioCard.locator('[data-action="submit-embed"]').isVisible())
);
await audioCard.locator('[data-action="submit-embed"]').click();
await page.waitForTimeout(400);
check(
  "Submit closes audio editing with the new source",
  (await audioCard.locator("audio").count()) === 1 &&
    (await audioCard.locator('[data-action="edit-embed"]').count()) === 1
);
await audioCard.locator('[data-action="audio-toggle"]').click();
await page.waitForTimeout(800);
check(
  "Audio player plays an uploaded file",
  await audioCard.locator("audio").evaluate((audio) => audio.currentTime > 0 || audio.ended)
);
const audioCardBox = await audioCard.boundingBox();
const audioWrapBox = await audioCard.locator(".mn-audio").boundingBox();
check(
  "Audio player fills the card without a bottom gap",
  Math.abs(audioCardBox.y + audioCardBox.height / 2 - (audioWrapBox.y + audioWrapBox.height / 2)) < 2 &&
    Math.abs(audioCardBox.height - audioWrapBox.height) < 2,
  `${Math.round(audioCardBox.height)} / ${Math.round(audioWrapBox.height)}`
);
const columnAudioId = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const actions = await import("/js/actions.js");
  const column = store.state.board.cards.find((card) => card.type === "column");
  const card = actions.addCard("audio", column.x + 20, column.y + 200, {
    parentId: column.id,
    order: 99,
    url: "https://example.com/sample.mp3",
  });
  return card.id;
});
await page.waitForTimeout(500);
const columnAudioHeight = await page.evaluate(async (id) => {
  const store = await import("/js/store.js");
  return store.state.board.cards.find((card) => card.id === id)?.h;
}, columnAudioId);
check(
  "Audio cards keep their fitted height inside a column",
  columnAudioHeight === 44,
  String(columnAudioHeight)
);
await page.evaluate(async (id) => {
  const actions = await import("/js/actions.js");
  actions.deleteCards([id]);
}, columnAudioId);

const imageRatioHeight = await page.evaluate(async () => {
  const model = await import("/js/model.js");
  return model.cardHeightFor({ type: "image", w: 260, aspect: 0.5 });
});
check(
  "Image cards match the uploaded image ratio with room for the caption",
  imageRatioHeight === 544,
  String(imageRatioHeight)
);
await page.keyboard.press("Escape");
await page.keyboard.press("Delete");
await page.waitForTimeout(300);

// ---------------------------------------------------------------- file card hover and download
const fileChooserPromise = page.waitForEvent("filechooser");
await page.click('.mn-tool[data-tool="upload"]');
const fileChooser = await fileChooserPromise;
await fileChooser.setFiles(path.join(here, "package.json"));
await page.waitForTimeout(900);
const fileCard = page.locator(".mn-card-file").last();
const fileCardBox = await fileCard.boundingBox();
const fileRowBox = await fileCard.locator(".mn-file").boundingBox();
check(
  "File card hover highlight is inset from the card edge",
  fileRowBox.x > fileCardBox.x + 2 &&
    fileRowBox.y > fileCardBox.y + 2 &&
    fileRowBox.height < fileCardBox.height - 2,
  `${Math.round(fileRowBox.height)} / ${Math.round(fileCardBox.height)}`
);
check("File card has a download button", (await fileCard.locator('[data-action="download-file"]').count()) === 1);
await fileCard.hover();
await page.waitForTimeout(250);
check(
  "File card download button appears on hover",
  (await fileCard
    .locator('[data-action="download-file"]')
    .evaluate((el) => getComputedStyle(el).opacity)) === "1"
);
await fileCard.click({ button: "right" });
await page.waitForTimeout(300);
check(
  "File context menu offers Download asset",
  (await page.locator(".mn-menu").innerText()).includes("Download asset")
);
await page.locator(".mn-menu-item", { hasText: "Delete" }).click();
await page.waitForTimeout(400);

// ---------------------------------------------------------------- dropped file classification
const dropKinds = await page.evaluate(async () => {
  const module = await import("/js/file-drop.js");
  return ["photo.JPG", "raw.cr2", "report.pdf", "song.mp3", "clip.mp4", "assets.zip"].map(
    (name) => `${name}:${module.classifyDropFile(name)}`
  );
});
check(
  "Dropped files are classified by extension",
  dropKinds.join("|") === "photo.JPG:image|raw.cr2:file|report.pdf:file|song.mp3:audio|clip.mp4:video|assets.zip:file",
  dropKinds.join("|")
);

// ---------------------------------------------------------------- media placeholder sizing
const emptyMediaBoxes = [];
for (const type of ["video", "audio", "map"]) {
  await page.evaluate(async (cardType) => {
    const actions = await import("/js/actions.js");
    actions.addCardAtCenter(cardType);
  }, type);
  await page.waitForTimeout(350);
  emptyMediaBoxes.push(await page.locator(`.mn-card-${type}`).last().boundingBox());
}
const emptyMediaWidths = emptyMediaBoxes.map((box) => Math.round(box.width));
const emptyMediaHeights = emptyMediaBoxes.map((box) => Math.round(box.height));
check(
  "Empty media cards share the same width and fit their content",
  new Set(emptyMediaWidths).size === 1 &&
    Math.max(...emptyMediaHeights) - Math.min(...emptyMediaHeights) <= 1,
  `${emptyMediaWidths.join(",")} / ${emptyMediaHeights.join(",")}`
);
for (const type of ["video", "audio", "map"]) {
  const card = page.locator(`.mn-card-${type}`).last();
  const box = await card.boundingBox();
  await card.evaluate((el, point) => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: point.x,
        clientY: point.y,
      })
    );
  }, { x: box.x + 5, y: box.y + 5 });
  await page.waitForTimeout(250);
  await page.locator(".mn-menu-item", { hasText: "Delete" }).click();
  await page.waitForTimeout(300);
}

// Restore the temporary disable list so the rest of the suite runs against the real policy.
await page.evaluate(async () => {
  const limits = await import("/js/limits.js");
  Object.assign(limits.TEMPORARILY_DISABLED_TOOLS, window.__disabledToolsBackup || {});
  delete window.__disabledToolsBackup;
});

// ---------------------------------------------------------------- drawing popup
await page.click('.mn-tool[data-tool="sketch"]');
await page.waitForTimeout(250);
const sketchId = await selectedId();
const sketch = byId(sketchId);
await sketch.locator(".mn-sketch").dblclick();
await page.waitForTimeout(400);
check("Drawing editor opens", await page.locator(".mn-draw-overlay").isVisible());
const canvasBox = await page.locator(".mn-draw-canvas").boundingBox();
await page.mouse.move(canvasBox.x + 80, canvasBox.y + 80);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 200, canvasBox.y + 160, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
check(
  "Pen options show colour swatches and sizes",
  (await page.locator(".mn-draw-options").isVisible()) &&
    (await page.locator(".mn-draw-swatch").count()) >= 6 &&
    (await page.locator(".mn-draw-size").count()) === 3,
  `${await page.locator(".mn-draw-swatch").count()} colours, ${await page.locator(".mn-draw-size").count()} sizes`
);
await page.click('.mn-draw-swatch[title="#d64545"]');
await page.locator(".mn-draw-size").last().click();
await page.mouse.move(canvasBox.x + 300, canvasBox.y + 80);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 380, canvasBox.y + 150, { steps: 10 });
await page.mouse.up();
await page.click('.mn-draw-tool[title="Highlighter"]');
await page.waitForTimeout(200);
check("Highlighter options stay available", await page.locator(".mn-draw-options").isVisible());
await page.mouse.move(canvasBox.x + 120, canvasBox.y + 270);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 280, canvasBox.y + 300, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.locator('[data-role="save"]').click();
await page.waitForTimeout(1500);
check(
  "Autosave waits 5s after the last change",
  (await page.locator("#save-state").innerText()).includes("Saving"),
  await page.locator("#save-state").innerText()
);
await page.waitForTimeout(4300);
check(
  "Autosave saves after 5s idle",
  (await page.locator("#save-state").innerText()).includes("Saved"),
  await page.locator("#save-state").innerText()
);
const strokeData = await page.evaluate((id) => {
  const raw = localStorage.getItem("mn.board." + localStorage.getItem("mn.lastBoard"));
  const doc = raw ? JSON.parse(raw) : null;
  const card = doc?.cards.find((entry) => entry.id === id);
  return card?.strokes || [];
}, sketchId);
check("Drawing saves strokes", (await page.locator(".mn-draw-overlay").count()) === 0 && strokeData.length === 3, `${strokeData.length} strokes`);
check("Pen colour and size options apply", strokeData[1]?.color === "#d64545" && strokeData[1]?.w === 0.012, JSON.stringify(strokeData[1]));
check("Highlighter options apply", strokeData[2]?.tool === "highlighter" && strokeData[2]?.a === 0.35, JSON.stringify(strokeData[2]));

// ---------------------------------------------------------------- column drag feedback
await page.click('.mn-tool[data-tool="column"]');
await page.waitForTimeout(250);
const columnId = await selectedId();
const column = byId(columnId);
const columnBox = await column.boundingBox();
const sourceId = (await cardIds())[1];
const sourceNote = byId(sourceId);
const sourceBox = await sourceNote.boundingBox();
await page.mouse.move(sourceBox.x + 30, sourceBox.y + 12);
await page.mouse.down();
await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + 90, { steps: 6 });
const dropLineVisible = await page.locator(".mn-drop-line").isVisible().catch(() => false);
const ghostVisible = await page.locator(".mn-drop-ghost").isVisible().catch(() => false);
await page.mouse.up();
await page.waitForTimeout(450);
check("Drag shows drop line and ghost", dropLineVisible && ghostVisible);
check("Card can be dropped into a column", (await column.innerText()).includes("1 card"), (await column.innerText()).replace(/\s+/g, " ").slice(0, 40));
const childRadius = await page
  .locator(`.mn-card[data-id="${sourceId}"]`)
  .evaluate((el) => getComputedStyle(el).borderRadius);
check("Column child radius softens to 4px", parseFloat(childRadius) === 4, childRadius);
const columnExpandedBox = await column.boundingBox();
const columnToggle = column.locator(".mn-column-toggle");
const columnToggleBox = await columnToggle.boundingBox();
check(
  "Column collapse button sits inside the card",
  columnToggleBox.x >= columnExpandedBox.x &&
    columnToggleBox.y >= columnExpandedBox.y &&
    columnToggleBox.x + columnToggleBox.width <= columnExpandedBox.x + columnExpandedBox.width &&
    columnToggleBox.y + columnToggleBox.height <= columnExpandedBox.y + columnExpandedBox.height,
  `button ${Math.round(columnToggleBox.x)},${Math.round(columnToggleBox.y)} card ${Math.round(columnExpandedBox.x)},${Math.round(columnExpandedBox.y)}`
);
await column.locator(".mn-column-toggle").click();
await page.waitForTimeout(450);
const columnCollapsedBox = await column.boundingBox();
check(
  "Column collapses with a small toggle",
  (await column.evaluate((el) => el.classList.contains("is-collapsed"))) &&
    columnCollapsedBox.height < columnExpandedBox.height &&
    !(await byId(sourceId).isVisible().catch(() => false)),
  `${Math.round(columnExpandedBox.height)} -> ${Math.round(columnCollapsedBox.height)}`
);
check("Collapsed column keeps its summary", (await column.innerText()).includes("1 card"), (await column.innerText()).replace(/\s+/g, " "));
await column.locator(".mn-column-toggle").click();
await page.waitForTimeout(450);
check(
  "Column expands again",
  !(await column.evaluate((el) => el.classList.contains("is-collapsed"))) && (await byId(sourceId).isVisible())
);

// ---------------------------------------------------------------- column live render
const childCard = page.locator(".mn-card.is-child").first();
const childBefore = await childCard.boundingBox();
const columnBox2 = await column.boundingBox();
await page.mouse.move(columnBox2.x + 40, columnBox2.y + 30);
await page.mouse.down();
await page.mouse.move(columnBox2.x + 100, columnBox2.y + 70, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(450);
const childAfter = await childCard.boundingBox();
check(
  "Column children move live while dragging the column",
  Math.abs(childAfter.x - childBefore.x - 60) < 14 && Math.abs(childAfter.y - childBefore.y - 40) < 14,
  `${Math.round(childAfter.x - childBefore.x)},${Math.round(childAfter.y - childBefore.y)}`
);

// ---------------------------------------------------------------- drag a child back out of the column
const liveChild = page.locator(`.mn-card[data-id="${sourceId}"]`);
const liveChildBox = await liveChild.boundingBox();
const liveColumnBox = await column.boundingBox();
await page.mouse.move(liveChildBox.x + 24, liveChildBox.y + 10);
await page.mouse.down();
await page.mouse.move(liveColumnBox.x - 160, liveChildBox.y + 140, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(550);
const stillChild = await liveChild.evaluate((el) => el.classList.contains("is-child"));
check(
  "Card can be dragged out of a column",
  !stillChild && (await column.innerText()).includes("0 cards"),
  `child=${stillChild} column=${(await column.innerText()).replace(/\s+/g, " ")}`
);

// ---------------------------------------------------------------- nested board + breadcrumb
const boardsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("mn.boards") || "[]").length);
await page.click('.mn-tool[data-tool="board"]');
await page.waitForTimeout(500);
const boardsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("mn.boards") || "[]").length);
check("Board tool creates a nested board", boardsAfter === boardsBefore + 1, `${boardsBefore} -> ${boardsAfter}`);
const boardCardId = await selectedId();
const boardCard = byId(boardCardId);
check(
  "Board card shows a preview thumbnail",
  (await boardCard.locator(".mn-board-preview").count()) === 1 &&
    (await boardCard.locator(".mn-board-preview").innerText()).toLowerCase().includes("empty")
);
const boardCardBefore = await boardCard.boundingBox();
await page.mouse.move(boardCardBefore.x + 30, boardCardBefore.y + 20);
await page.mouse.down();
await page.mouse.move(boardCardBefore.x + 110, boardCardBefore.y + 60, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
const boardCardAfter = await boardCard.boundingBox();
check(
  "Board card can be dragged",
  Math.abs(boardCardAfter.x - boardCardBefore.x - 80) < 14 &&
    Math.abs(boardCardAfter.y - boardCardBefore.y - 40) < 14,
  `${Math.round(boardCardAfter.x - boardCardBefore.x)},${Math.round(boardCardAfter.y - boardCardBefore.y)}`
);
check(
  "Dragging a board card does not open it",
  (await page.locator(".mn-crumb.is-current").innerText()).toLowerCase().includes("home")
);
await page.locator('.mn-board-card').last().click();
await page.waitForTimeout(600);
check("Nested board opens with breadcrumbs", (await page.locator(".mn-crumb").count()) >= 2, `crumbs=${await page.locator(".mn-crumb").count()} current=${await page.locator(".mn-crumb.is-current").innerText()}`);

// Breadcrumb navigation still works right after editing a card (blur rebuilds the breadcrumb).
await page.click('.mn-tool[data-tool="note"]');
await page.waitForTimeout(400);
await page.locator(".mn-crumb").first().click();
await page.waitForTimeout(600);
check(
  "Breadcrumb navigates after editing a card",
  (await page.locator(".mn-crumb.is-current").innerText()).toLowerCase().includes("home"),
  await page.locator(".mn-crumb.is-current").innerText()
);
await page.locator('.mn-board-card').last().click();
await page.waitForTimeout(600);

// nested board comment, aggregated in the comments popup of the parent
await page.click('.mn-tool[data-tool="comment"]');
await page.waitForTimeout(300);
const nestedCommentId = await selectedId();
const nestedComment = byId(nestedCommentId);
await nestedComment.locator('[data-field="comment-draft"]').fill("Nested comment");
await nestedComment.locator('[data-action="send-comment"]').click();
await page.waitForTimeout(400);
check("Nested board comment saved", (await nestedComment.innerText()).includes("Nested comment"));
await page.locator(".mn-crumb").first().click();
await page.waitForTimeout(700);
await page.click("#comment-count");
await page.waitForTimeout(900);
const popupText = await page.locator(".mn-comments-pop").innerText();
check("Comments popup aggregates nested boards", popupText.includes("Nested comment") && popupText.includes("Looks good"), popupText.replace(/\s+/g, " ").slice(0, 90));
check("Comment meta shows the board path", popupText.includes("New board"));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Escape closes the comments popup", (await page.locator(".mn-comments-pop").count()) === 0);

// ---------------------------------------------------------------- single-file header and template library
let rootCrumb = page.locator(".mn-crumb").first();
if ((await page.locator(".mn-crumb").count()) > 1) {
  await rootCrumb.click();
  await page.waitForTimeout(500);
}
check(
  "Home gallery is disabled and the logo opens templates",
  (await page.locator("#home-page").isHidden())
);
await page.click("#template-btn");
await page.waitForTimeout(400);
check(
  "Template library opens from the header",
  (await page.locator(".mn-template-modal").isVisible()) &&
    (await page.locator(".mn-template-card").count()) >= 6
);
const cardsBeforeTemplate = await page.locator(".mn-card").count();
await page.locator(".mn-template-card", { hasText: "Kanban board" }).click();
await page.waitForTimeout(400);
check(
  "Template overwrite shows a warning on a full board",
  (await page.locator(".mn-template-confirm").isVisible()) &&
    (await page.locator(".mn-template-confirm").innerText()).includes("Overwrite this board?")
);
await page.locator('.mn-template-confirm [data-confirm="cancel"]').click();
await page.waitForTimeout(300);
check(
  "Cancel keeps the current board content",
  (await page.locator(".mn-card").count()) === cardsBeforeTemplate &&
    (await page.locator(".mn-template-modal").isVisible())
);
await page.locator(".mn-template-card", { hasText: "Kanban board" }).click();
await page.waitForTimeout(300);
await page.locator('.mn-template-confirm [data-confirm="apply"]').click();
await page.waitForTimeout(700);
check(
  "Template library applies a starter board",
  (await page.locator(".mn-card-kanban").count()) === 1 &&
    (await page.locator(".mn-crumb.is-current").innerText()).includes("Kanban board")
);
await page.click("#template-btn");
await page.waitForTimeout(400);
await page.locator(".mn-template-card", { hasText: "Welcome board" }).click();
await page.waitForTimeout(300);
await page.locator('.mn-template-confirm [data-confirm="apply"]').click();
await page.waitForTimeout(700);
check(
  "Welcome template can be restored from the library",
  (await page.locator(".mn-card").count()) >= 15 &&
    (await page.locator(".mn-crumb.is-current").innerText()).includes("Welcome board")
);

// ---------------------------------------------------------------- tool rail drag reorder
const firstToolBefore = await page.locator(".mn-tool").first().getAttribute("data-tool");
const reorderNoteToolBox = await page.locator('.mn-tool[data-tool="note"]').boundingBox();
const reorderLinkToolBox = await page.locator('.mn-tool[data-tool="link"]').boundingBox();
await page.mouse.move(
  reorderNoteToolBox.x + reorderNoteToolBox.width / 2,
  reorderNoteToolBox.y + reorderNoteToolBox.height / 2
);
await page.mouse.down();
await page.mouse.move(
  reorderLinkToolBox.x + reorderLinkToolBox.width / 2,
  reorderLinkToolBox.y + reorderLinkToolBox.height / 2,
  { steps: 8 }
);
await page.mouse.up();
await page.waitForTimeout(500);
const firstToolAfter = await page.locator(".mn-tool").first().getAttribute("data-tool");
const savedOrder = await page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem("mn.settings") || "{}").toolOrder;
  } catch {
    return null;
  }
});
check(
  "Tool rail can be reordered by drag",
  firstToolAfter === "link" && Array.isArray(savedOrder) && savedOrder[0] === "link",
  `${firstToolBefore} -> ${firstToolAfter}`
);

// ---------------------------------------------------------------- drag a rail tool onto the canvas
const notesBeforeDrop = await page.locator(".mn-card-note").count();
const viewportBox = await page.locator("#viewport").boundingBox();
const dragToolBox = await page.locator('.mn-tool[data-tool="note"]').boundingBox();
await page.mouse.move(dragToolBox.x + dragToolBox.width / 2, dragToolBox.y + dragToolBox.height / 2);
await page.mouse.down();
await page.mouse.move(viewportBox.x + 520, viewportBox.y + 520, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
const notesAfterDrop = await page.locator(".mn-card-note").count();
const droppedId = await selectedId();
const droppedBox = await byId(droppedId).boundingBox();
check(
  "Tool can be dragged from the rail onto the canvas",
  notesAfterDrop === notesBeforeDrop + 1 &&
    Math.abs(droppedBox.x + droppedBox.width / 2 - (viewportBox.x + 520)) < 40 &&
    Math.abs(droppedBox.y + droppedBox.height / 2 - (viewportBox.y + 520)) < 40,
  `${notesBeforeDrop} -> ${notesAfterDrop} at ${Math.round(droppedBox.x)},${Math.round(droppedBox.y)}`
);

// ---------------------------------------------------------------- duplicate and copy a column tree
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1300);
const firstColumn = page.locator(".mn-card-column").first();
const columnChildCount = Number((await firstColumn.locator(".mn-column-summary").innerText()).match(/\d+/)?.[0] || 0);
const columnsBeforeTree = await page.locator(".mn-card-column").count();
const childrenBeforeTree = await page.locator(".mn-card.is-child").count();
await firstColumn.locator(".mn-column-head").click();
await page.waitForTimeout(200);
await page.keyboard.press("Control+d");
await page.waitForTimeout(500);
const columnsAfterDuplicate = await page.locator(".mn-card-column").count();
const childrenAfterDuplicate = await page.locator(".mn-card.is-child").count();
check(
  "Duplicate a column copies its child items",
  columnsAfterDuplicate === columnsBeforeTree + 1 &&
    childrenAfterDuplicate === childrenBeforeTree + columnChildCount &&
    columnChildCount > 0,
  `${columnsBeforeTree}->${columnsAfterDuplicate} columns, ${childrenBeforeTree}->${childrenAfterDuplicate} children, childCount=${columnChildCount}`
);
check(
  "Duplicated column keeps the same child count",
  Number((await page.locator(".mn-card-column").last().locator(".mn-column-summary").innerText()).match(/\d+/)?.[0] || 0) ===
    columnChildCount
);
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
await page.keyboard.press("Control+v");
await page.waitForTimeout(500);
check(
  "Copy and paste of a column copies its children",
  (await page.locator(".mn-card-column").count()) === columnsBeforeTree + 2 &&
    (await page.locator(".mn-card.is-child").count()) === childrenBeforeTree + columnChildCount * 2
);

// ---------------------------------------------------------------- settings dialog
await page.click("#settings-btn");
await page.waitForTimeout(400);
check("Settings dialog opens", await page.locator(".mn-prefs-dialog").isVisible());
check(
  "Topbar language button is present but disabled",
  (await page.locator("#language-btn").isVisible()) && (await page.locator("#language-btn").isDisabled())
);
check(
  "Account is the first settings page",
  (await page.locator(".mn-prefs-nav-item.is-active").innerText()).trim() === "Account"
);
const navLabels = (await page.locator(".mn-prefs-nav-item").allInnerTexts()).map((label) => label.trim());
check(
  "Settings navigation follows the requested order",
  navLabels.join(",") === "Account,Backup,General,Appearance,Tools,Performance,MCP,About",
  navLabels.join(", ")
);
check("Settings navigation has two dividers", (await page.locator(".mn-prefs-nav-sep").count()) === 2);
check(
  "Settings overlay uses a blurred glass backdrop",
  (await page.locator(".mn-prefs-overlay").evaluate((el) => getComputedStyle(el).backdropFilter)).includes("blur")
);
check(
  "Account page links the service pages",
  (await page.locator('[data-role="content"]').innerText()).includes("Server: not connected") &&
    (await page.locator(".mn-account-grid").innerText()).includes("Passkeys") &&
    (await page.locator(".mn-account-grid").innerText()).includes("Sharing")
);
check("Account no longer contains the backup controls", (await page.locator(".mn-account-backup").count()) === 0);
await page.locator(".mn-prefs-nav-item", { hasText: "Backup" }).click();
await page.waitForTimeout(300);
check(
  "Backup page exposes backup, ZIP export and open folder controls",
  (await page.locator(".mn-account-backup").isVisible()) &&
    (await page.locator(".mn-account-backup-actions .mn-btn", { hasText: "Back up now" }).count()) === 1 &&
    (await page.locator(".mn-account-backup-actions .mn-btn", { hasText: "Export ZIP" }).count()) === 1
);
check(
  "Backup page offers automatic backup intervals and the last run",
  (await page.locator(".mn-account-backup .mn-prefs-select").count()) >= 1 &&
    (await page.locator(".mn-account-backup").innerText()).includes("Automatic backup") &&
    (await page.locator(".mn-account-backup").innerText()).includes("Last automatic backup")
);
await page.locator(".mn-account-backup select").selectOption("7");
await page.waitForTimeout(300);
const autoBackupDays = await page.evaluate(
  () => JSON.parse(localStorage.getItem("mn.settings")).autoBackupDays
);
check("Automatic backup interval is saved", autoBackupDays === 7, String(autoBackupDays));
await page.locator(".mn-account-backup select").selectOption("0");
await page.locator(".mn-prefs-nav-item", { hasText: "General" }).click();
await page.waitForTimeout(300);
check(
  "Language is merged into General as coming soon",
  (await page.locator(".mn-prefs-content").innerText()).includes("English only") &&
    (await page.locator(".mn-prefs-select select").first().isDisabled())
);
const prefsHead = await page.locator(".mn-prefs-head").evaluate((el) => {
  const style = getComputedStyle(el);
  return { background: style.backgroundColor, color: style.color };
});
const prefsHeadRgb = (prefsHead.background.match(/[\d.]+/g) || []).map(Number);
const headAlpha = prefsHeadRgb.length >= 4 ? prefsHeadRgb[3] : 1;
const headLuminance =
  (prefsHeadRgb[0] || 0) * headAlpha +
  (prefsHeadRgb[1] || 0) * headAlpha +
  (prefsHeadRgb[2] || 0) * headAlpha +
  255 * (1 - headAlpha) * 3;
check("Settings header follows the light theme", headLuminance > 450, prefsHead.background);
const nestedRadius = await page.evaluate(() => {
  const dialog = document.querySelector(".mn-prefs-dialog");
  const shell = document.querySelector(".mn-prefs-shell");
  return {
    dialog: getComputedStyle(dialog).borderTopLeftRadius,
    padding: getComputedStyle(dialog).paddingTop,
    shell: getComputedStyle(shell).borderTopLeftRadius,
  };
});
check(
  "Settings nested radius follows outer minus inset",
  Math.abs(parseFloat(nestedRadius.shell) - (parseFloat(nestedRadius.dialog) - parseFloat(nestedRadius.padding))) < 0.6,
  `${nestedRadius.dialog} - ${nestedRadius.padding} = ${nestedRadius.shell}`
);
check("Settings has only the essential categories", (await page.locator(".mn-prefs-nav-item").count()) === 8, String(await page.locator(".mn-prefs-nav-item").count()));
check(
  "Language and Canvas are merged away",
  !navLabels.some((label) => ["Language", "Canvas", "Integrations", "History Log", "Scratch Disks", "Plug-ins", "Units & Rulers"].includes(label)),
  navLabels.join(", ")
);
check("General page is selected", (await page.locator(".mn-prefs-nav-item.is-active").innerText()).trim() === "General");
check("Custom Khaoyu select enhanced in settings", (await page.locator(".mn-prefs-select .ky-select-trigger").count()) >= 1);

// Tools pane is a two-column icon grid
await page.locator(".mn-prefs-nav-item", { hasText: "Tools" }).click();
await page.waitForTimeout(350);
const toolLabels = await page.locator(".mn-tool-card-label").allInnerTexts();
check(
  "Tools settings lists every tool including Kanban",
  toolLabels.includes("Kanban") && toolLabels.length === 19,
  `${toolLabels.length} labels, kanban=${toolLabels.includes("Kanban")}`
);
const toolsGridColumns = await page
  .locator(".mn-tools-grid")
  .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
check("Tools are arranged in a two-column grid", toolsGridColumns === 2, String(toolsGridColumns));
check(
  "Each tool card shows an icon before its name",
  (await page.locator(".mn-tool-card-icon svg").count()) === 19
);
const disabledToolCards = await page.evaluate(() =>
  [...document.querySelectorAll(".mn-tool-card.is-disabled")].map((card) => ({
    label: card.querySelector(".mn-tool-card-label")?.textContent || "",
    state: card.querySelector(".mn-tool-card-state")?.textContent || "",
    disabled: card.disabled,
  }))
);
check(
  "Temporarily disabled tools stay listed with a disabled status",
  disabledToolCards.length === 3 &&
    ["Audio", "Map", "Video"].every((label) =>
      disabledToolCards.some(
        (entry) =>
          entry.label === label &&
          entry.state === "Disabled (temporarily)" &&
          entry.disabled
      )
    ),
  JSON.stringify(disabledToolCards)
);
const firstTool = page.locator(".mn-tool-card").first();
await firstTool.click();
await page.waitForTimeout(250);
check("Tool visibility can be toggled from the grid", (await firstTool.getAttribute("aria-pressed")) === "false");
await firstTool.click();
await page.waitForTimeout(200);

// MCP settings pane
await page.locator(".mn-prefs-nav-item", { hasText: "MCP" }).click();
await page.waitForTimeout(350);
const mcpLabels = await page.locator(".mn-prefs-label").allInnerTexts();
const mcpCodes = await page.locator(".mn-prefs-code").allInnerTexts();
check(
  "MCP settings shows server details and the generic JSON config",
  ["Server binary", "Transport", "Database", "Tools"].every((label) => mcpLabels.includes(label)) &&
    mcpCodes.length === 1 &&
    mcpCodes[0].includes("mcpServers") &&
    !mcpCodes[0].includes("dsh-mcp-client")
);

// GPU acceleration toggle under Performance
await page.locator(".mn-prefs-nav-item", { hasText: "Performance" }).click();
await page.waitForTimeout(300);
const gpuToggle = page.locator('.mn-prefs-check', { hasText: "GPU acceleration" });
check("GPU acceleration option exists", (await gpuToggle.count()) >= 1, String(await gpuToggle.count()));
check("GPU acceleration defaults to on", await gpuToggle.locator("input").isChecked());
const perfLabels = await page.locator(".mn-prefs-label").allInnerTexts();
check(
  "Performance lists GPU and CPU details",
  ["GPU", "GPU vendor", "Graphics API", "CPU", "Memory", "Platform", "WebView"].every((label) => perfLabels.includes(label)),
  perfLabels.join(", ")
);
check(
  "Performance does not mention the design system",
  !(await page.locator(".mn-prefs-content").innerText()).includes("Khaoyu")
);
const modeValue = await page.locator('.mn-prefs-row', { hasText: "Current mode" }).locator(".mn-prefs-value").innerText();
check("Performance reports the active rendering mode", modeValue.includes("GPU"), modeValue);
await gpuToggle.locator(".mn-prefs-check-box").click();
await page.waitForTimeout(450);
check(
  "CPU mode is reported when GPU is off",
  (await page.locator('.mn-prefs-row', { hasText: "Current mode" }).locator(".mn-prefs-value").innerText()).includes("CPU")
);
check("GPU off shows restart hint", (await page.locator(".mn-prefs-hint").innerText()).includes("Restart"));
const persistedGpu = await page.evaluate(() => localStorage.getItem("mn.settings") || "");
check("GPU preference persists", String(persistedGpu).includes('"gpuAcceleration":false'), String(persistedGpu).slice(0, 80));
await page.locator('.mn-prefs-check', { hasText: "GPU acceleration" }).locator(".mn-prefs-check-box").click();
await page.waitForTimeout(300);

// search filters settings
await page.fill(".mn-prefs-search-input", "gpu");
await page.waitForTimeout(300);
check("Settings search filters results", (await page.locator(".mn-prefs-content").innerText()).toLowerCase().includes("gpu acceleration"));
await page.fill(".mn-prefs-search-input", "");
await page.waitForTimeout(300);

// theme through Appearance
await page.locator(".mn-prefs-nav-item", { hasText: "Appearance" }).click();
await page.waitForTimeout(300);
await page.locator(".mn-prefs-select .ky-select-trigger").first().click();
await page.waitForTimeout(200);
await page.locator('.ky-select-item[data-value="dark"]').first().click();
await page.waitForTimeout(250);
check("Theme switches to dark from settings", (await page.evaluate(() => document.documentElement.dataset.kyTheme)) === "dark");
await page.locator(".mn-prefs-select .ky-select-trigger").first().click();
await page.locator('.ky-select-item[data-value="light"]').first().click();
await page.waitForTimeout(200);
const appearanceLabels = await page.locator(".mn-prefs-label").allInnerTexts();
check(
  "Appearance exposes heading, body and code fonts",
  ["Heading font", "Body font", "Code font"].every((label) => appearanceLabels.includes(label)),
  appearanceLabels.join(", ")
);
const bodyFontRow = page.locator(".mn-prefs-row", { hasText: "Body font" });
await bodyFontRow.locator(".ky-select-trigger").click();
await page.waitForTimeout(200);
await page.locator('.ky-select-item[data-value="DM Sans"]').first().click();
await page.waitForTimeout(350);
const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
check("Body font switches to DM Sans", bodyFont.includes("DM Sans"), bodyFont);
await bodyFontRow.locator(".ky-select-trigger").click();
await page.waitForTimeout(200);
await page.locator('.ky-select-item[data-value="Plus Jakarta Sans"]').first().click();
await page.waitForTimeout(250);
await page.locator(".mn-prefs-nav-item", { hasText: "About" }).click();
await page.waitForTimeout(300);
check(
  "About page reports the current version and storage",
  (await page.locator(".mn-prefs-content").innerText()).includes("Version") &&
    (await page.locator(".mn-prefs-content").innerText()).includes("0.23.2")
);
await page.locator('[data-role="done"]').click();
await page.waitForTimeout(250);
check("Done closes settings", (await page.locator(".mn-prefs-dialog").count()) === 0);

// ---------------------------------------------------------------- zoom + context menu
const zoomBefore = await page.locator("#zoom-label").innerText();
await page.click('.mn-zoom-btn[data-zoom="in"]');
await page.waitForTimeout(200);
check("Zoom buttons change zoom", (await page.locator("#zoom-label").innerText()) !== zoomBefore);
await page.click('.mn-zoom-btn[data-zoom="reset"]');

const menuPoint = await emptyPoint(-260, -260);
await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
await page.waitForTimeout(250);
check("Canvas context menu opens", await page.locator(".mn-menu").isVisible());
const cardMenu = await page.locator(".mn-menu").innerText();
const downloadDetection = await page.evaluate(async () => {
  const actions = await import("/js/actions.js");
  return {
    local: actions.assetPathForCard({ type: "file", path: "C:\\assets\\a.zip" }),
    remote: actions.assetPathForCard({ type: "video", url: "https://example.com/a.mp4" }),
    plain: actions.assetPathForCard({ type: "note" }),
  };
});
check(
  "Download is offered only for local uploaded assets",
  downloadDetection.local.endsWith("a.zip") && !downloadDetection.remote && !downloadDetection.plain
);
check(
  "Card context menu uses grouped items",
  ["Cut", "Copy", "Duplicate", "Bring to front", "Delete"].every((label) => cardMenu.includes(label)),
  cardMenu.replace(/\s+/g, " ").slice(0, 100)
);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const canvasPoint = await page.evaluate(() => {
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  for (let y = rect.top + 70; y < rect.bottom - 90; y += 45) {
    for (let x = rect.left + 70; x < rect.right - 70; x += 45) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest("#viewport") && !el.closest(".mn-card")) return { x, y };
    }
  }
  return { x: rect.left + 200, y: rect.top + 200 };
});
await page.mouse.click(canvasPoint.x, canvasPoint.y, { button: "right" });
await page.waitForTimeout(250);
const canvasMenu = await page.locator(".mn-menu").innerText();
check(
  "Canvas menu offers every card type and grouped view actions",
  [
    "Undo",
    "Redo",
    "New note",
    "New link",
    "New to-do",
    "New line",
    "New heading",
    "New board",
    "New column",
    "New comment",
    "New table",
    "New image",
    "New file",
    "Select all",
    "Zoom in",
    "Reset zoom",
  ].every((label) => canvasMenu.includes(label)),
  canvasMenu.replace(/\s+/g, " ").slice(0, 160)
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Escape closes the menu", (await page.locator(".mn-menu").count()) === 0);

// ---------------------------------------------------------------- wrap selection in a column
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1400);
await page.keyboard.press("Control+a");
await page.waitForTimeout(300);
const columnsBeforeWrap = await page.locator(".mn-card-column").count();
const totalBeforeWrap = await page.locator(".mn-card").count();
const childrenBeforeWrap = await page.locator(".mn-card.is-child").count();
const allAnchor = await page.evaluate(() => {
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  for (let y = rect.top + 90; y < rect.bottom - 40; y += 30) {
    for (let x = rect.left + 80; x < rect.right - 40; x += 30) {
      const el = document.elementFromPoint(x, y);
      const card = el && el.closest(".mn-card");
      if (card && card.closest("#viewport")) return { x, y };
    }
  }
  return { x: rect.left + 300, y: rect.top + 300 };
});
await page.mouse.click(allAnchor.x, allAnchor.y, { button: "right" });
await page.waitForTimeout(300);
const allMenu = await page.locator(".mn-menu").innerText();
check(
  "Select all with a column does not offer wrap in column",
  !allMenu.includes("Wrap in column"),
  allMenu.replace(/\s+/g, " ").slice(0, 90)
);
await page.keyboard.press("Escape");
const clearPoint = await emptyPoint();
await page.mouse.click(clearPoint.x, clearPoint.y);
await page.waitForTimeout(200);
const wrapPair = await page.evaluate(() => {
  const viewport = document.getElementById("viewport").getBoundingClientRect();
  return [...document.querySelectorAll(".mn-card:not(.is-child):not(.mn-card-column)")]
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => {
      const x = rect.left + Math.min(24, rect.width / 2);
      const y = rect.top + Math.min(18, rect.height / 2);
      const target = document.elementFromPoint(x, y);
      return (
        rect.width > 40 &&
        rect.height > 20 &&
        rect.left > viewport.left &&
        rect.right < viewport.right &&
        rect.top > viewport.top &&
        rect.bottom < viewport.bottom &&
        target?.closest(".mn-card") === el &&
        !target.closest('input, button, a, [contenteditable="true"], [role="button"]')
      );
    })
    .slice(0, 2)
    .map(({ rect }) => ({ x: rect.left + 24, y: rect.top + 18 }));
});
check("two selectable non-column cards are visible", wrapPair.length === 2, `${wrapPair.length} found`);
await page.mouse.click(wrapPair[0].x, wrapPair[0].y);
await page.keyboard.down("Shift");
await page.mouse.click(wrapPair[1].x, wrapPair[1].y);
await page.keyboard.up("Shift");
await page.waitForTimeout(200);
await page.mouse.click(wrapPair[1].x, wrapPair[1].y, { button: "right" });
await page.waitForTimeout(300);
const wrapMenu = await page.locator(".mn-menu").innerText();
check("Multi-selection offers wrap in column", wrapMenu.includes("Wrap in column"), wrapMenu.replace(/\s+/g, " ").slice(0, 90));
await page.locator(".mn-menu-item", { hasText: "Wrap in column" }).click();
await page.waitForTimeout(650);
check(
  "Wrap in column creates a column with the selected cards",
  (await page.locator(".mn-card-column").count()) === columnsBeforeWrap + 1 &&
    (await page.locator(".mn-card").count()) === totalBeforeWrap + 1 &&
    (await page.locator(".mn-card.is-child").count()) > childrenBeforeWrap
);
await page.keyboard.press("Control+z");
await page.waitForTimeout(650);
check(
  "Wrap in column is undoable",
  (await page.locator(".mn-card-column").count()) === columnsBeforeWrap &&
    (await page.locator(".mn-card").count()) === totalBeforeWrap
);
await page.keyboard.press("Escape");

// ---------------------------------------------------------------- freehand drawing and contextual toolbars
await page.click('.mn-tool[data-tool="draw"]');
await page.waitForTimeout(400);
check(
  "Draw tool opens a contextual move, pen and eraser toolbar",
  (await page.locator(".mn-context-bar").isVisible()) &&
    (await page.locator("[data-draw-mode]").count()) === 3
);
await page.mouse.move(1220, 470);
await page.mouse.down();
await page.mouse.move(1320, 540, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(600);
const drawingCard = page.locator(".mn-card-drawing").last();
check(
  "Freehand stroke becomes a vector drawing card",
  (await page.locator(".mn-card-drawing").count()) === 1 &&
    (await drawingCard.locator(".mn-drawing path").getAttribute("d")).length > 20
);
const drawingBoxBefore = await drawingCard.boundingBox();
await page.locator('[data-draw-mode="move"]').click();
await page.waitForTimeout(200);
await page.mouse.move(drawingBoxBefore.x + 20, drawingBoxBefore.y + 20);
await page.mouse.down();
await page.mouse.move(drawingBoxBefore.x + 60, drawingBoxBefore.y + 35, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
check(
  "Drawing card can be selected and moved",
  (await drawingCard.boundingBox()).x > drawingBoxBefore.x + 20
);
await page.locator('[data-draw-mode="eraser"]').click();
await page.waitForTimeout(200);
const drawingBoxAfter = await drawingCard.boundingBox();
await page.mouse.click(drawingBoxAfter.x + 20, drawingBoxAfter.y + 20);
await page.waitForTimeout(500);
check("Drawing can be erased", (await page.locator(".mn-card-drawing").count()) === 0);
await page.click('.mn-tool[data-tool="draw"]');
await page.waitForTimeout(350);
await page.click('.mn-tool[data-tool="note"]');
await page.waitForTimeout(450);
const toolbarNote = page.locator(".mn-card-note").last();
const toolbarNoteBox = await toolbarNote.boundingBox();
await page.mouse.dblclick(toolbarNoteBox.x + 30, toolbarNoteBox.y + 25);
await page.waitForTimeout(400);
check(
  "Text cards show a markdown-style contextual toolbar",
  (await page.locator(".mn-context-format").count()) === 7 &&
    (await page.locator(".mn-context-bar").isVisible())
);
await page.mouse.click(toolbarNoteBox.x + 8, toolbarNoteBox.y + 8);
await page.click(".mn-trash");
await page.waitForTimeout(350);

// ---------------------------------------------------------------- persistence + screenshot
await page.waitForTimeout(5600);
const persisted = await page.evaluate(() => {
  const ids = JSON.parse(localStorage.getItem("mn.boards") || "[]");
  let total = 0;
  let max = 0;
  for (const id of ids) {
    const raw = localStorage.getItem("mn.board." + id);
    if (!raw) continue;
    try {
      const doc = JSON.parse(raw);
      total += (doc.cards || []).length;
      max = Math.max(max, (doc.cards || []).length);
    } catch {
      /* ignore */
    }
  }
  return { boards: ids.length, total, max };
});
check("Board persists card edits", persisted.max >= 15, JSON.stringify(persisted));
check("Single-file header keeps the template menu visible", await page.locator("#template-btn").isVisible());
check("Sync state is explicit and off by default", (await page.locator("#sync-state").innerText()).includes("Sync"));
await page.click("#sync-state");
await page.waitForTimeout(250);
check(
  "Sync dialog exposes server URL, email, password and sign-in action",
  (await page.locator(".mn-sync-panel").isVisible()) &&
    (await page.locator(".mn-sync-field").count()) === 3 &&
    (await page.locator(".mn-sync-foot").innerText()).includes("Sign in and connect")
);
await page.locator(".mn-sync-panel .mn-modal-close").click();
check("Sync dialog closes without changing the board", (await page.locator(".mn-sync-overlay").count()) === 0);
await page.click("#share-btn");
await page.waitForTimeout(300);
check(
  "Header share control explains the server requirement before sharing",
  (await page.locator(".mn-share-panel").isVisible()) &&
    (await page.locator(".mn-share-panel").innerText()).includes("Connect a server")
);
await page.locator(".mn-share-panel .mn-modal-close").click();
check("Share panel closes", (await page.locator(".mn-share-overlay").count()) === 0);
await page.locator(".mn-menubar-btn", { hasText: "Help" }).click();
await page.locator(".mn-menu-item", { hasText: "Documentation" }).click();
await page.waitForTimeout(250);
check(
  "Help > Documentation opens the tabbed documentation page",
  (await page.locator(".mn-modal-title").innerText()) === "Documentation" &&
    (await page.locator(".mn-docs-nav-item").count()) >= 12 &&
    (await page.locator(".mn-docs").innerText()).includes("local-first")
);
check(
  "Documentation navigation includes MCP and API sections",
  (await page.locator('.mn-docs-nav-item[data-doc="mcp"]').count()) === 1 &&
    (await page.locator('.mn-docs-nav-item[data-doc="api"]').count()) === 1
);
await page.locator('.mn-docs-nav-item[data-doc="sync"]').click();
await page.waitForTimeout(150);
check(
  "Documentation switches to the Server sync section",
  (await page.locator(".mn-docs").innerText()).includes("Sign in and connect")
);
await page.locator('.mn-docs-nav-item[data-doc="mcp"]').click();
await page.waitForTimeout(150);
check(
  "Documentation MCP section lists the board tools",
  (await page.locator(".mn-docs").innerText()).includes("khaoyu-note-mcp") &&
    (await page.locator(".mn-docs").innerText()).includes("create_card")
);
await page.locator(".mn-modal-close").click();
check("Documentation page closes", (await page.locator(".mn-docs").count()) === 0);

const linkCard = page.locator('.mn-card[data-type="link"]').first();
if (await linkCard.count()) {
  check(
    "Links without a fetched hero image show the dotted globe fallback",
    (await linkCard.locator(".mn-link-header-default").isVisible()) &&
      (await linkCard.locator(".mn-link-header-default svg").count()) === 1
  );
  const dotStyle = await linkCard.locator(".mn-link-header-default").evaluate((el) => {
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, size: style.backgroundSize };
  });
  check(
    "Fallback dots match the board dot spacing",
    dotStyle.image.includes("radial-gradient") && dotStyle.size === "24px 24px",
    `${dotStyle.size}`
  );
  await linkCard.click({ button: "right" });
  await page.waitForTimeout(250);
  await page.locator(".mn-menu-item", { hasText: /header image/i }).first().click();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4YwAAAAASUVORK5CYII=",
    "base64"
  );
  await page.locator('input[type="file"]').setInputFiles({ name: "header.png", mimeType: "image/png", buffer: png });
  await page.waitForTimeout(800);
  const headerImage = linkCard.locator(".mn-link-header img");
  check(
    "Link header image renders a visible preview",
    (await headerImage.count()) === 1 && (await headerImage.isVisible()) && (await headerImage.boundingBox())?.height > 0
  );
  await linkCard.click({ button: "right" });
  await page.waitForTimeout(250);
  check(
    "Link menu offers free crop for the header image",
    (await page.locator(".mn-menu-item", { hasText: "Crop header image" }).count()) === 1
  );
  await page.locator(".mn-menu-item", { hasText: "Crop header image" }).click();
  await page.waitForTimeout(600);
  check(
    "Crop dialog exposes Fit to image and Apply crop",
    (await page.locator(".mn-crop-panel").isVisible()) &&
      (await page.locator('[data-role="fit"]').isVisible()) &&
      (await page.locator('[data-role="apply"]').isVisible())
  );
  const cropBox = await page.locator(".mn-crop-box").boundingBox();
  await page.mouse.move(cropBox.x + cropBox.width - 4, cropBox.y + cropBox.height - 4);
  await page.mouse.down();
  await page.mouse.move(cropBox.x + cropBox.width * 0.7, cropBox.y + cropBox.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await page.locator('[data-role="apply"]').click();
  await page.waitForTimeout(500);
  check(
    "Free crop updates the header image region",
    (await linkCard.locator(".mn-link-header").getAttribute("class")).includes("is-cropped") &&
      (await linkCard.locator(".mn-link-header img").getAttribute("style")).includes("width:")
  );
  await linkCard.click({ button: "right" });
  await page.waitForTimeout(250);
  check(
    "Link menu offers Remove header image when a header exists",
    (await page.locator(".mn-menu-item", { hasText: "Remove header image" }).count()) === 1
  );
  await page.locator(".mn-menu-item", { hasText: "Remove header image" }).click();
  await page.waitForTimeout(400);
  check(
    "Remove header image clears the image and restores the default hero",
    (await linkCard.locator(".mn-link-header img").count()) === 0 &&
      (await linkCard.locator(".mn-link-header-default").count()) === 1
  );
}
const imageCard = page.locator('.mn-card[data-type="image"]').first();
if (await imageCard.count()) {
  await imageCard.click({ button: "right" });
  await page.waitForTimeout(250);
  check(
    "Image card menu offers free crop",
    (await page.locator(".mn-menu-item", { hasText: "Crop image" }).count()) === 1
  );
  await page.locator(".mn-menu-item", { hasText: "Crop image" }).click();
  await page.waitForTimeout(600);
  await page.locator('[data-role="fit"]').click();
  await page.locator('[data-role="apply"]').click();
  await page.waitForTimeout(500);
  check(
    "Image card stores and renders the crop",
    (await imageCard.locator(".mn-image-crop.is-cropped").count()) === 1 &&
      (await imageCard.locator(".mn-image-crop img").isVisible())
  );
}
check("No runtime errors", errors.length === 0, errors.slice(0, 4).join(" | "));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) console.log(errors.join("\n"));
await browser.close();
process.exit(failed.length ? 1 : 0);
