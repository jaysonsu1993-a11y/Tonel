using System.Collections.Generic;

namespace TonelWindows.Audio;

/// <summary>
/// Per-peer jitter buffer holding decoded float frames (120 samples each).
/// Mirrors macOS JitterBuffer — depth-capped FIFO, drop oldest when full,
/// re-prime after underrun. PrimeMin is a static field so the AudioDebugSheet
/// sliders can tune all per-peer buffers live without recreating them.
/// </summary>
public sealed class JitterBuffer
{
    public static int MaxDepth = 8;
    public static int PrimeMin = 2;

    private readonly object _gate = new();
    private readonly Queue<float[]> _frames = new();
    private bool _primed;
    public ushort? LastSeq { get; private set; }
    public int DropOldestCount { get; private set; }
    public int SeqGapCount { get; private set; }

    public void Push(float[] frame, ushort sequence)
    {
        lock (_gate)
        {
            if (LastSeq is ushort prev)
            {
                ushort expected = unchecked((ushort)(prev + 1));
                if (sequence != expected) SeqGapCount++;
            }
            LastSeq = sequence;
            if (_frames.Count >= MaxDepth)
            {
                _frames.Dequeue();
                DropOldestCount++;
            }
            _frames.Enqueue(frame);
            if (_frames.Count >= PrimeMin) _primed = true;
        }
    }

    public float[]? Pop()
    {
        lock (_gate)
        {
            if (!_primed || _frames.Count == 0) return null;
            var f = _frames.Dequeue();
            if (_frames.Count == 0) _primed = false;     // re-prime after underrun
            return f;
        }
    }

    public int Depth { get { lock (_gate) return _frames.Count; } }
}
