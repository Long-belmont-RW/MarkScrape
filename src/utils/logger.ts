import chalk from 'chalk';
import ora, { type Ora } from 'ora';

export class Logger {
  private spinner: Ora | null = null;

  public startSpinner(text: string): Ora {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.spinner = ora({
      text: chalk.cyan(text),
      color: 'cyan',
    }).start();
    return this.spinner;
  }

  public updateSpinner(text: string): void {
    if (this.spinner) {
      this.spinner.text = chalk.cyan(text);
    }
  }

  public succeedSpinner(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text ? chalk.green(text) : undefined);
      this.spinner = null;
    }
  }

  public warnSpinner(text: string): void {
    if (this.spinner) {
      this.spinner.warn(chalk.yellow(text));
      this.spinner = null;
    } else {
      this.warn(text);
    }
  }

  public failSpinner(text?: string): void {
    if (this.spinner) {
      this.spinner.fail(text ? chalk.red(text) : undefined);
      this.spinner = null;
    }
  }

  public info(message: string): void {
    const wasSpinning = this.spinner?.isSpinning;
    if (wasSpinning) this.spinner?.stop();
    console.log(`${chalk.blue('ℹ')} ${message}`);
    if (wasSpinning) this.spinner?.start();
  }

  public success(message: string): void {
    const wasSpinning = this.spinner?.isSpinning;
    if (wasSpinning) this.spinner?.stop();
    console.log(`${chalk.green('✔')} ${message}`);
    if (wasSpinning) this.spinner?.start();
  }

  public warn(message: string): void {
    const wasSpinning = this.spinner?.isSpinning;
    if (wasSpinning) this.spinner?.stop();
    console.warn(`${chalk.yellow('⚠')} ${chalk.yellow(message)}`);
    if (wasSpinning) this.spinner?.start();
  }

  public error(message: string, err?: unknown): void {
    const wasSpinning = this.spinner?.isSpinning;
    if (wasSpinning) this.spinner?.stop();
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    console.error(
      `${chalk.red('✖')} ${chalk.red(message)}${detail ? chalk.gray(` (${detail})`) : ''}`
    );
    if (wasSpinning) this.spinner?.start();
  }
}

export const logger = new Logger();
