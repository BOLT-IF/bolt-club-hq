/** Per-platform install instructions, shared by the prompt card and the /install guide. */

export function IosSteps() {
  return (
    <ol className="bcq-install__steps">
      <li>
        Open this page in <strong>Safari</strong>.
      </li>
      <li>
        Tap the <strong>Share</strong> button{" "}
        <span aria-hidden="true">(the square with an arrow)</span>.
      </li>
      <li>
        Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
      </li>
    </ol>
  );
}

export function AndroidSteps() {
  return (
    <ol className="bcq-install__steps">
      <li>
        Open the browser menu <span aria-hidden="true">(⋮)</span>.
      </li>
      <li>
        Choose <strong>Install app</strong> or <strong>Add to home screen</strong>.
      </li>
    </ol>
  );
}
