import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AutoResultBadge, Avatar, Deadline, StatusBadge } from './ui.jsx';

describe('AutoResultBadge', () => {
  test('distinguishes passed, failed and teacher-graded', () => {
    const { rerender } = render(<AutoResultBadge autoPassed />);
    expect(screen.getByText('Tests passed')).toBeInTheDocument();

    rerender(<AutoResultBadge autoPassed={false} />);
    expect(screen.getByText('Tests failed')).toBeInTheDocument();

    // null is not a failure: the question has no test cases.
    rerender(<AutoResultBadge autoPassed={null} />);
    expect(screen.getByText('Teacher-graded')).toBeInTheDocument();
  });

  test('has a compact form for lists', () => {
    render(<AutoResultBadge autoPassed compact />);
    expect(screen.getByText('Pass')).toBeInTheDocument();
  });
});

describe('Deadline', () => {
  test('says when there is no deadline', () => {
    render(<Deadline value={null} />);
    expect(screen.getByText('No deadline')).toBeInTheDocument();
  });

  test('marks a past deadline as overdue', () => {
    render(<Deadline value={new Date(Date.now() - 2 * 86400000 - 3600000).toISOString()} />);
    expect(screen.getByText('2d overdue')).toBeInTheDocument();
  });

  test('counts down to a future deadline', () => {
    render(<Deadline value={new Date(Date.now() + 3 * 86400000 + 3600000).toISOString()} />);
    expect(screen.getByText('in 3d')).toBeInTheDocument();
  });
});

describe('StatusBadge and Avatar', () => {
  test('a worksheet is either published or a draft', () => {
    const { rerender } = render(<StatusBadge status="published" />);
    expect(screen.getByText('Published')).toBeInTheDocument();
    rerender(<StatusBadge status="draft" />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  test('an avatar shows up to two initials', () => {
    render(<Avatar user={{ name: 'Aditya Kumar Menon' }} />);
    expect(screen.getByText('AK')).toBeInTheDocument();
  });
});
